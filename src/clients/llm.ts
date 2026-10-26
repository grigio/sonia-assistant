/**
 * LLM leg — one interface, two interchangeable backends:
 *
 *  * the OpenAI-compatible API of the already-running llama-server (default), or
 *  * the `pi` CLI (cfg.llmViaPi) — delegated to `PiSession` (see pi.ts).
 */

import type { Config } from "../config";
import { contextsFromServerModels } from "../context";
import { timeoutSignal } from "../util";
import type { ChatMessage, StreamItem, ToolCall, TurnVerdict } from "./llm-types";
import { PiSession } from "./pi";
import { sseData } from "./sse";
import { ThinkTagFilter } from "./think";

export type { ChatMessage, StreamItem, ToolCall, TurnVerdict } from "./llm-types";

export class LLM {
  readonly pi: PiSession;
  /** n_ctx per model id, read from the last `GET /v1/models` (the context bar's denominator). */
  private ctxById: Record<string, number> = {};

  constructor(private readonly cfg: Config) {
    this.pi = new PiSession(cfg);
  }

  get viaPi(): boolean {
    return Boolean(this.cfg.llmViaPi);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.llmApiKey) h.Authorization = `Bearer ${this.cfg.llmApiKey}`;
    return h;
  }

  private get base(): string {
    return this.cfg.llmBaseUrl.replace(/\/+$/, "");
  }

  /**
   * One `POST {base}/chat/completions` for the whole class: the JSON headers, the
   * timeout *and* the caller's AbortSignal (a barge-in must stop this request now, not
   * when the timeout lands), plus the error report every endpoint shares —
   * `${label} HTTP ${status}: <first bytes of the body>` — so a failure names the leg
   * that failed instead of appearing four times, slightly differently.
   */
  private async post(
    label: string,
    base: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const r = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: timeoutSignal(timeoutMs, signal),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`${label} HTTP ${r.status}: ${t.slice(0, 300)}`);
    }
    return r;
  }

  // ── turn-taking judge (LISTEN/REPLY) ────────────────────────────────────────

  /** True when the judge has an endpoint and/or a model of its own (DECISION_* set). */
  get judgeDedicated(): boolean {
    return Boolean(this.cfg.decisionBaseUrl || this.cfg.decisionModel);
  }

  /** Endpoint the judge calls: DECISION_BASE_URL, else the main one. */
  get judgeBase(): string {
    return (this.cfg.decisionBaseUrl || this.cfg.llmBaseUrl).replace(/\/+$/, "");
  }

  /** Model the judge runs on: DECISION_MODEL, else the main one. */
  get judgeModel(): string {
    return this.cfg.decisionModel || this.cfg.llmModel;
  }

  /** The verdict is asked over the API unless the session runs on pi *and* no judge
   *  knobs are set (an explicit DECISION_* wins even on the pi leg: it points at a
   *  real endpoint, which is faster than spawning a pi process per pause). */
  private get judgeViaApi(): boolean {
    return !this.viaPi || this.judgeDedicated;
  }

  private get thinking(): boolean {
    return !this.cfg.llmDisableThinking;
  }

  /**
   * Per-request extras. `thinking` defaults to the session setting; the turn-taking
   * judge passes `false` (4 tokens would all be spent thinking instead of answering).
   */
  private extra(thinking = this.thinking): Record<string, unknown> {
    return {
      model: this.cfg.llmModel,
      cache_prompt: true,
      chat_template_kwargs: { enable_thinking: thinking },
    };
  }

  // ── model list ───────────────────────────────────────────────────────────

  /** The model ids of the active leg (also verifies the leg is usable). */
  async check(force = false): Promise<string[]> {
    if (this.viaPi) {
      this.pi.exe(); // throws when pi is not installed / not in PATH
      return await this.pi.modelIds(force);
    }
    let r: Response;
    try {
      r = await fetch(`${this.base}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new Error(
        `LLM ${this.base}: models did not answer in 10 s (${e instanceof Error ? e.message : e})`,
      );
    }
    // a 401/500 used to look like an empty model list: without this the harness started
    // "fine" against a broken leg and only failed later, on the first real request
    if (!r.ok) throw new Error(`LLM ${this.base}: models HTTP ${r.status}`);
    let js: { data?: { id?: string }[] };
    try {
      js = (await r.json()) as { data?: { id?: string }[] };
    } catch {
      throw new Error(`LLM ${this.base}: models returned unparsable JSON`);
    }
    this.ctxById = contextsFromServerModels(js); // n_ctx for the context bar (no model is loaded by asking)
    return (js.data ?? []).map((m) => m.id ?? "");
  }

  // ── context window ───────────────────────────────────────────────────────

  /**
   * n_ctx of the active model — the denominator of the header's context bar.
   * `LLM_CONTEXT_WINDOW` wins; otherwise whichever model list `check()` last ran
   * (`/v1/models` for this leg, `pi --list-models` for the other). 0 = unknown,
   * and an unknown denominator hides the bar instead of guessing it.
   */
  async contextWindow(): Promise<number> {
    const cfg = this.cfg;
    if (cfg.llmContextWindow > 0) return Math.trunc(cfg.llmContextWindow);
    const model = this.viaPi ? cfg.piModel : cfg.llmModel;
    if (!model) return 0;
    if (this.viaPi) {
      const piCtx = await this.pi.contextWindows();
      if ((piCtx[model] ?? 0) > 0) return piCtx[model]!;
      // `llamacpp/<alias>`: llama-server knows that alias under its bare id
      const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
      return this.ctxById[bare] ?? 0;
    }
    return this.ctxById[model] ?? 0;
  }

  // ── warmup ───────────────────────────────────────────────────────────────

  /** Load the model (router mode loads on first request) and prime the prompt cache. */
  async warmup(systemPrompt: string): Promise<void> {
    if (this.viaPi) {
      // one tiny stateless run: starts pi and pulls its model into llama-server now,
      // instead of on the first (voice) turn.
      const argv = [this.pi.exe(), "--no-session", "-p", ...this.pi.flags(false), "--", "Ciao"];
      await this.pi.once(argv, 180_000);
      return;
    }
    const body = {
      ...this.extra(),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Ciao" },
      ],
      max_tokens: 1,
      temperature: 0,
    };
    const r = await this.post("LLM warmup", this.base, body, 600_000);
    await r.arrayBuffer();
  }

  // ── decision prompt (turn-taking judge) ──────────────────────────────────

  /**
   * Prime the judge's own prompt prefix (system = the decision prompt, 4 tokens), so the
   * first real pause answers from a warm cache instead of paying a cold prompt eval
   * (450 ms → 121 ms measured on an earlier default). A no-op
   * while DECISION_MODE=off
   * or when pi judges itself; throws on failure (the caller downgrades it to a warning).
   */
  async warmupJudge(decisionPrompt: string): Promise<void> {
    if (this.cfg.decisionMode === "off" || !this.judgeViaApi) return;
    const body = {
      ...this.extra(false),
      model: this.judgeModel,
      messages: [
        { role: "system", content: decisionPrompt },
        { role: "user", content: 'Recent context:\n(none)\n\nUser transcript so far:\n""' },
      ],
      max_tokens: 4,
      temperature: 0,
    };
    // 120 s: a cold dedicated server loads its model right here
    const r = await this.post("judge warmup", this.judgeBase, body, 120_000);
    await r.arrayBuffer();
  }

  /** Cheap control completion: returns 'listen' or 'speak'. */
  async decide(
    decisionPrompt: string,
    historyTail: string,
    transcript: string,
    signal?: AbortSignal,
  ): Promise<TurnVerdict> {
    const user =
      `Recent context:\n${historyTail || "(none)"}\n\n` +
      `User transcript so far:\n"${transcript}"`;
    if (!this.judgeViaApi) {
      // stateless one-shot: --no-session so it never lands in the conversation, and the
      // turn-taking rules as *the* system prompt
      const argv = [
        this.pi.exe(),
        "--no-session",
        "--no-tools",
        "-p",
        "--system-prompt",
        decisionPrompt,
        ...this.pi.flags(false, false),
        "--",
        user,
      ];
      const out = await this.pi.once(argv, 15_000, signal);
      return verdict(out);
    }
    const body = {
      ...this.extra(false),
      model: this.judgeModel, // DECISION_MODEL may differ from the conversation's model
      messages: [
        { role: "system", content: decisionPrompt },
        { role: "user", content: user },
      ],
      max_tokens: 4,
      temperature: 0,
    };
    // the timeout bounds a stalled llama-server, the caller's signal makes cancelling
    // the response stop *this* request too (instead of 15 s later)
    const r = await this.post("judge", this.judgeBase, body, 15_000, signal);
    const js = (await r.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    return verdict(js.choices?.[0]?.message?.content ?? "");
  }

  // ── streaming answer ─────────────────────────────────────────────────────

  /**
   * Yields `reasoning` deltas (the model's thinking — UI only), `text` deltas, `tool`
   * card payloads, `event` notes, then optionally `tool_calls` for the API leg's
   * function calling.
   */
  async *stream(
    messages: ChatMessage[],
    tools: Record<string, unknown>[] | null,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamItem, void, unknown> {
    if (this.viaPi) {
      yield* this.pi.stream(messages);
      return;
    }
    const body: Record<string, unknown> = {
      ...this.extra(),
      messages,
      stream: true,
      // last chunk carries `usage`: prompt+completion tokens = the context that request used
      stream_options: { include_usage: true },
      max_tokens: this.cfg.llmMaxTokens + (this.thinking ? this.cfg.llmReasoningBudget : 0),
      temperature: this.cfg.llmTemperature,
    };
    if (tools) body.tools = tools;

    // `signal` is the response's own controller: a barge-in (or a ✕) aborts the request
    // itself, so llama-server stops generating instead of us walking away from a stream
    // that keeps burning CPU until the 300 s timeout lands.
    const r = await this.post("LLM", this.base, body, 300_000, signal);
    if (!r.body) throw new Error("LLM: empty body");

    const calls = new Map<number, ToolCall>();
    const think = new ThinkTagFilter(); // models that keep reasoning inside `content`
    for await (const data of sseData(r.body as unknown as AsyncIterable<Uint8Array>)) {
      if (data === "[DONE]") break;
      let js: Record<string, unknown>;
      try {
        js = JSON.parse(data);
      } catch {
        continue;
      }
      // the final chunk has `choices: []` and holds the usage — read it first
      const usage = js.usage as
        | { prompt_tokens?: unknown; completion_tokens?: unknown }
        | undefined;
      if (usage && typeof usage.prompt_tokens === "number") {
        const completion =
          typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
        yield { kind: "usage", prompt: usage.prompt_tokens, completion };
      }
      const choices = js.choices as { delta?: Record<string, unknown> }[] | undefined;
      if (!choices?.length) continue;
      const delta = choices[0]!.delta ?? {};
      const reasoning = ["reasoning_content", "reasoning", "reasoning_text"]
        .map((k) => delta[k])
        .find((v) => typeof v === "string" && v !== "") as string | undefined;
      if (reasoning) yield { kind: "reasoning", text: reasoning };
      if (typeof delta.content === "string" && delta.content) {
        for (const part of think.feed(delta.content)) yield part;
      }
      const tcs = delta.tool_calls as
        | { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
        | undefined;
      for (const tc of tcs ?? []) {
        const index = tc.index ?? 0;
        let slot = calls.get(index);
        if (!slot) {
          slot = { id: "", type: "function", function: { name: "", arguments: "" } };
          calls.set(index, slot);
        }
        if (tc.id) slot.id = tc.id;
        slot.function.name += tc.function?.name ?? "";
        slot.function.arguments += tc.function?.arguments ?? "";
      }
    }
    for (const part of think.flush()) yield part;
    if (calls.size) {
      const sorted = [...calls.keys()].sort((a, b) => a - b).map((i) => calls.get(i)!);
      yield { kind: "tool_calls", calls: sorted };
    }
  }

  // ── tool gate (which of this round's calls did the user actually ask for?) ───────────

  /**
   * One judge question per round of tool calls: of the proposed tools, which does the
   * user's latest message clearly ask for? Returns their indexes (0-based; possibly
   * none). Throws on any failure — the caller then lets every call through, because a
   * judge hiccup must never block a real action.
   *
   * `proposed[].args` (one line, pre-truncated) and `skills` exist for the same reason:
   * the words are speech recognition, so the judge must be able to match a spoken
   * approximation to what was actually proposed — "web surfics" →
   * `{"name":"websurfx"}` — instead of denying a call it cannot place.
   *
   * `doing` is the same idea one step further: the calls this answer has already run for
   * this very request ("read_skill {hackernews} → --- name: hackernews …"). Without it
   * the judge sees a bare user message plus a new command and reads a follow-up of the
   * request as the model's own initiative (data/logs/harness.log 13:38:38-13:44:28: three
   * follow-up calls denied before being allowed on the identical retry, one never
   * retried at all).
   */
  async judgeTools(
    gatePrompt: string,
    prevAssistant: string,
    userText: string,
    proposed: { name: string; description: string; args?: string }[],
    skills = "",
    doing: string[] = [],
    signal?: AbortSignal,
  ): Promise<Set<number>> {
    const list = proposed
      .map((p, i) => `${i + 1}. ${p.name}${p.args ? ` ${p.args}` : ""} — ${p.description}`)
      .join("\n");
    const context = prevAssistant
      ? `What the assistant just said:\n"${prevAssistant.slice(0, 400)}"\n\n`
      : "";
    const ongoing = doing.length
      ? `What this answer is already doing for the same request:\n${doing
          .map((d, i) => `${i + 1}. ${d}`)
          .join("\n")}\n\n`
      : "";
    const active = skills ? `Active skills: ${skills}\n\n` : "";
    const user =
      `${context}${ongoing}Proposed tools:\n${list}\n\n${active}` +
      `User's latest message:\n"${userText.slice(0, 400)}"`;
    const body = {
      ...this.extra(false),
      model: this.judgeModel, // same knobs as the turn-taking judge (DECISION_MODEL…)
      messages: [
        { role: "system", content: gatePrompt },
        { role: "user", content: user },
      ],
      max_tokens: 16,
      temperature: 0,
    };
    // `signal` is the response's own controller: a barge-in (or a ✕) aborts the judge
    // too, instead of the turn waiting out its full 15 s after the user stopped it
    const r = await this.post("tool-gate", this.judgeBase, body, 15_000, signal);
    const js = (await r.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    const allowed = parseToolGate(js.choices?.[0]?.message?.content ?? "", proposed.length);
    if (!allowed) throw new Error("tool-gate: unparsable judge answer");
    return allowed;
  }

  // ── session / mode ───────────────────────────────────────────────────────

  /** The UI toggled the checkbox: pi's session may miss the turns made via the API. */
  onModeChange(): void {
    this.pi.onModeChange();
  }

  resetSession(): void {
    this.pi.resetSession();
  }

  /** ⟲ rewind: pi's session cannot be cut, so start a new one and re-seed it with the
   *  history that survived (the API leg needs none: it sends that history every turn). */
  rewindSession(): void {
    this.pi.rewindSession();
  }
}

/**
 * The judge's one word → the turn-taking verdict, as `prompts/decision.txt` words it
 * (`LISTEN` / `REPLY`, with the Italian stem a model may answer with). Exported because
 * this is one half of a contract whose other half is hand-written prose: the prompt test
 * pins the two together.
 */
export function verdict(out: string): TurnVerdict {
  const s = (out ?? "").trim().toLowerCase();
  return s.startsWith("ascolt") || s.startsWith("listen") ? "listen" : "speak";
}

/**
 * The tool gate's one-line answer → the indexes (0-based) of the allowed tools.
 * "NONE" → none; a list like "2,3" → those tools (1-based, out-of-range ignored);
 * empty or prose without a number → null, which the caller turns into "no gate".
 */
export function parseToolGate(out: string, count: number): Set<number> | null {
  const s = (out ?? "").trim();
  if (!s) return null;
  if (/\bNONE\b/i.test(s)) return new Set();
  if (!/\d/.test(s)) return null;
  const allowed = new Set<number>();
  for (const m of s.matchAll(/\d+/g)) {
    const i = Number(m[0]);
    if (i >= 1 && i <= count) allowed.add(i - 1);
  }
  return allowed;
}

/**
 * One denial per turn and call: the judge runs at temperature 0 over the same words
 * every round, so after denying a call it denies the identical call forever — a model
 * that retries anyway would spend all TOOL_ROUNDS on it (data/logs/harness.log 11:35:48: six
 * `read_skill` rounds, first token at 15.2 s, then an unrelated answer).
 *
 * `keys[i]` identifies proposed call *i* (`name + args`); `denied` survives across the
 * rounds of one turn. Returns the indexes to let through anyway (the caller logs them
 * as `↻`) and records the calls denied for the first time.
 */
export function allowGateRetries(
  allowed: Set<number>,
  keys: string[],
  denied: Map<string, number>,
): Set<number> {
  const retry = new Set<number>();
  for (let i = 0; i < keys.length; i++) {
    if (allowed.has(i)) continue;
    const key = keys[i] ?? "";
    if (denied.has(key)) {
      allowed.add(i);
      retry.add(i);
    } else {
      denied.set(key, 1);
    }
  }
  return retry;
}
