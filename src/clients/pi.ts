/**
 * The `pi` CLI leg: `pi -c "<prompt>" --mode json` as a subprocess.
 *
 * Handles the session flags, the `conv<n>` cwd namespace, env sanitisation, JSONL
 * streaming and model-id parsing.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../config";
import { t, type Locale } from "../i18n";
import { shlexSplit } from "../shlex";
import { which, appendCapped, abortError } from "../util";
import { contextsFromPiList, piModelRows } from "../context";
import { piResultText, piToolInfo, toolEnd, toolStart } from "./toolcards";
import type { ChatMessage, StreamItem } from "./llm-types";

/** pi session ids of *our* caller must never leak into the assistant's own session */
export const PI_DROP_ENV = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_SESSION_DIR"];
export const SESSION_FLAGS = ["-c", "--continue", "--session", "--session-id"];
/** Cap on the stdout/stderr a one-shot pi subprocess may accumulate (kept: the tail). */
const CAP_BYTES = 256_000;

/** what we add to the voice prompt so pi's own tools/skills are the ones to use */
export const PI_ADDENDUM = (locale: Locale): string => t(locale, "pi.addendum");

/**
 * The whole tail pi's `--append-system-prompt` gets: pi's own rules first, the locale's
 * language default last, so it is the freshest instruction of the prompt (the same line
 * the API leg appends — see `Assistant.systemPrompt`).
 */
export const PI_SYSTEM_TAIL = (locale: Locale): string =>
  `${PI_ADDENDUM(locale)}\n\n${t(locale, "prompt.langDefault")}`;

/** pi's per-message token usage (`docs/message-types.md`: assistant messages always carry it). */
type PiUsage = { input?: unknown; output?: unknown };

export class PiSession {
  private conv: number;
  private prime = false;
  private models: string[] | null = null;
  /** Context window per model id, from the same cached `pi --list-models` run as `models`. */
  private ctxById: Record<string, number> = {};
  private modelsAt = 0;
  private static readonly MODELS_TTL_MS = 300_000;

  constructor(private readonly cfg: Config) {
    this.conv = this.resumeConv();
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  /** Resolve the binary of PI_CMD (PATH, then ~/.bun/bin). */
  exe(): string {
    const name = shlexSplit(this.cfg.piCmd)[0]!;
    if (name.includes("/")) return name;
    const found = which(name);
    if (found) return found;
    const home = path.join(os.homedir(), ".bun", "bin", name);
    if (fs.existsSync(home)) return home;
    throw new Error(`'${name}' non trovato in PATH (aggiungi ~/.bun/bin)`);
  }

  env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    for (const key of PI_DROP_ENV) delete env[key];
    if (this.cfg.piModel) {
      // we pass --model explicitly: don't let the caller's PI_PROVIDER/PI_MODEL disagree
      delete env["PI_PROVIDER"];
      delete env["PI_MODEL"];
    }
    return env;
  }

  /** pi groups sessions by cwd: conv<n> is one conversation, /reset starts conv<n+1>. */
  cwd(): string {
    const d = path.join(this.cfg.piCwd, `conv${this.conv}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  /** Continue the newest conv<n> that already exists in PI_CWD (restart safety). */
  private resumeConv(): number {
    let max = 0;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.cfg.piCwd);
    } catch {
      return 0;
    }
    for (const name of entries) {
      const m = /^conv(\d+)$/.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  }

  /** The UI toggled the checkbox: pi's session may miss the turns made via the API. */
  onModeChange(): void {
    this.prime = this.cfg.llmViaPi;
  }

  /** "🧹 Pulisci chat": pi keeps its own memory, so move on to conv<n+1>. */
  resetSession(): void {
    this.conv++;
    this.prizeReset();
  }

  /**
   * "⟲ rewind the conversation": pi's own session cannot be cut, so move on to conv<n+1>
   * *and* leave `prime` on — the next prompt is then rendered from the whole history that
   * survived, which seeds the fresh session with exactly the turns that are still there.
   * (🧹 calls `resetSession()` instead: what survives is nothing.)
   */
  rewindSession(): void {
    this.conv++;
    this.prime = true;
  }
  private prizeReset(): void {
    this.prime = false;
  }

  flags(jsonMode = false, system = true): string[] {
    const cfg = this.cfg;
    const cmd = shlexSplit(cfg.piCmd);
    const has = (flag: string) => cmd.some((arg) => arg === flag || arg.startsWith(flag + "="));
    const flags: string[] = [];
    if (jsonMode && !has("--mode")) flags.push("--mode", "json");
    if (cfg.piModel && !has("--model")) flags.push("--model", cfg.piModel);
    // pi's level, forced off when the master switch (LLM_DISABLE_THINKING) is off
    const thinking = cfg.llmDisableThinking ? "off" : cfg.piThinking;
    if (thinking && !has("--thinking")) flags.push("--thinking", thinking);
    if (system && !has("--system-prompt") && !has("--append-system-prompt")) {
      flags.push(
        "--append-system-prompt",
        fs.readFileSync(cfg.systemPromptFile, "utf-8").trim() + PI_SYSTEM_TAIL(cfg.locale),
      );
    }
    return flags;
  }

  // ── model ids ────────────────────────────────────────────────────────────

  /** `pi --list-models` → `["provider/id", …]`, cached for 300 s (never a failed run). */
  async modelIds(force = false): Promise<string[]> {
    if (
      !force &&
      this.models &&
      performance.now() - this.modelsAt < PiSession.MODELS_TTL_MS
    ) {
      return [...this.models];
    }
    try {
      const out = await this.once([this.exe(), "--list-models"], 30_000);
      this.ctxById = contextsFromPiList(out); // the `context` column → the context bar
      const ids = parsePiModelIds(out);
      const list = ids.length ? ids : [this.cfg.piModel];
      this.models = list;
      this.modelsAt = performance.now();
      return [...list];
    } catch {
      return [this.cfg.piModel];
    }
  }

  /** Context window of every id pi can reach (`{}` until the first successful listing). */
  async contextWindows(): Promise<Record<string, number>> {
    await this.modelIds();
    return { ...this.ctxById };
  }

  // ── prompts ──────────────────────────────────────────────────────────────

  private static assistantText(msg: Record<string, unknown>): string {
    const content = msg["content"];
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .filter(
          (c): c is Record<string, unknown> =>
            typeof c === "object" && c !== null && (c["type"] === undefined || c["type"] === "text"),
        )
        .map((c) => String(c["text"] ?? "").trim())
        .filter(Boolean)
        .join(" ")
        .trim();
    }
    return "";
  }

  /** The whole conversation as one prompt (used when PI_CMD has no session flag).
   *  The role labels follow the locale: Italian in an Italian session, English otherwise. */
  private static render(messages: ChatMessage[], locale: Locale): string {
    const parts: string[] = [];
    for (const m of messages) {
      let content: unknown = m.content;
      if (Array.isArray(content)) {
        content = content
          .filter((c) => typeof c === "object" && c !== null)
          .map((c) => String((c as Record<string, unknown>)["text"] ?? ""))
          .join(" ");
      }
      const text = String(content ?? "").trim();
      if (!text) continue;
      if (m.role === "system") parts.push(text);
      else if (m.role === "user") parts.push(`${t(locale, "role.user")}: ${text}`);
      else if (m.role === "assistant") parts.push(`${t(locale, "role.assistant")}: ${text}`);
      else parts.push(`[${m.role}] ${text}`);
    }
    return parts.join("\n\n");
  }

  prompt(messages: ChatMessage[]): string {
    const argv = shlexSplit(this.cfg.piCmd);
    const session = argv.some((t) => SESSION_FLAGS.includes(t) || t.startsWith("--session="));
    if (session && this.prime) {
      // just switched into pi mode: seed pi's session with what the API already said
      this.prime = false;
      const hasAssistant = messages.some(
        (m) => m.role === "assistant" && String(m.content ?? "").trim(),
      );
      if (hasAssistant) return PiSession.render(messages, this.cfg.locale);
    }
    if (session) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role === "user" && String(m.content ?? "").trim()) return String(m.content).trim();
      }
      return "";
    }
    return PiSession.render(messages, this.cfg.locale);
  }

  // ── subprocesses ─────────────────────────────────────────────────────────

  /**
   * One-shot print mode: return stdout, reject on a non-zero exit, timeout or abort.
   * `signal` lets a cancelled conversation kill the subprocess instead of leaving it
   * running for its full timeout; stdout/stderr are capped (the tail is kept), so a
   * chatty pi cannot grow the heap without limit.
   */
  async once(argv: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const proc = spawn(argv[0]!, argv.slice(1), {
        cwd: this.cwd(),
        env: this.env(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const kill = () => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      };
      const onAbort = () =>
        finish(() => {
          kill();
          reject(abortError());
        });
      timer = setTimeout(
        () =>
          finish(() => {
            kill();
            reject(new Error(`pi: timeout ${Math.round(timeoutMs / 1000)} s`));
          }),
        timeoutMs,
      );
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      let out = "";
      let err = "";
      proc.stdout.on("data", (d) => (out = appendCapped(out, String(d), CAP_BYTES)));
      proc.stderr.on("data", (d) => (err = appendCapped(err, String(d), CAP_BYTES)));
      proc.on("error", (e) => finish(() => reject(e)));
      proc.on("close", (rc) =>
        finish(() => {
          if (rc) {
            const tail = (err || out).slice(-300).trim();
            reject(new Error(`pi exit ${rc}: ${tail}`));
          } else resolve(out);
        }),
      );
    });
  }

  /** `pi -c "<prompt>"` in --mode json: yields the assistant's text as it is generated. */
  async *stream(messages: ChatMessage[]): AsyncGenerator<StreamItem, void, unknown> {
    const cfg = this.cfg;
    const prompt = this.prompt(messages);
    const argv = [...shlexSplit(cfg.piCmd), ...this.flags(true), "--", prompt];

    const proc = spawn(argv[0]!, argv.slice(1), {
      cwd: this.cwd(),
      env: this.env(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    // drain stderr while reading stdout, or a chatty pi can fill the pipe and stall
    const err: string[] = [];
    proc.stderr.on("data", (d: Buffer) => {
      for (const line of String(d).split("\n")) {
        const l = line.trim();
        if (l) {
          err.push(l);
          if (err.length > 30) err.shift();
        }
      }
    });

    const deadline = performance.now() + cfg.piTimeoutS * 1000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, cfg.piTimeoutS * 1000);

    let gotText = false;
    let final = "";
    let streamingUsage: PiUsage | null = null; // cumulative while the response streams
    try {
      for await (const line of stdoutLines(proc)) {
        if (performance.now() > deadline) {
          timedOut = true;
          break;
        }
        if (!line) continue;
        let js: Record<string, unknown>;
        try {
          js = JSON.parse(line);
        } catch {
          yield { kind: "text", text: line + "\n" }; // print mode: pi wrote plain text
          gotText = true;
          continue;
        }
        const ev = (js["assistantMessageEvent"] as Record<string, unknown> | undefined) ?? {};
        const seen = js["usage"] as PiUsage | undefined; // cumulative for this response
        if (seen && typeof seen["input"] === "number") streamingUsage = seen;
        if (ev["type"] === "text_delta") {
          yield { kind: "text", text: String(ev["delta"] ?? "") };
          gotText = true;
        } else if (ev["type"] === "thinking_delta") {
          yield { kind: "reasoning", text: String(ev["delta"] ?? "") }; // UI only, not spoken
        } else if (ev["type"] === "error") {
          throw new Error(`pi: ${String(ev["error"] ?? ev["reason"])}`);
        } else if (js["type"] === "tool_execution_start") {
          yield {
            kind: "tool",
            tool: toolStart("pi", String(js["toolCallId"] ?? ""), String(js["toolName"] ?? "?"), js["args"]),
          };
        } else if (js["type"] === "tool_execution_end") {
          yield {
            kind: "tool",
            tool: toolEnd(
              "pi",
              String(js["toolCallId"] ?? ""),
              String(js["toolName"] ?? "?"),
              piResultText(js["result"]),
              piToolInfo(js["result"], cfg.locale),
              Boolean(js["isError"]),
            ),
          };
        } else if (js["type"] === "message_end") {
          const msg = (js["message"] as Record<string, unknown> | undefined) ?? {};
          if (msg["role"] !== "assistant") continue;
          if (msg["errorMessage"]) throw new Error(`pi: ${String(msg["errorMessage"]).slice(0, 300)}`);
          final = PiSession.assistantText(msg) || final;
          // one usage item per assistant message (never per delta): feeds the context bar
          const usage = (msg["usage"] as PiUsage | undefined) ?? streamingUsage;
          streamingUsage = null;
          if (usage && typeof usage["input"] === "number") {
            const output = typeof usage["output"] === "number" ? usage["output"] : 0;
            yield { kind: "usage", prompt: usage["input"], completion: output };
          }
        }
      }
      if (timedOut) throw new Error(`pi: timeout ${cfg.piTimeoutS} s`);

      const rc = await exitCode(proc);
      if (rc) throw new Error(`pi exit ${rc}: ${err.join(" | ").slice(-300)}`);
      if (final && !gotText) yield { kind: "text", text: final };
      if (!gotText && !final) {
        throw new Error("pi: no text in output" + (err.length ? ` — ${err.join(" | ").slice(-200)}` : ""));
      }
    } finally {
      clearTimeout(timer);
      if (proc.exitCode === null && !proc.killed) proc.kill("SIGKILL");
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function parsePiModelIds(text: string): string[] {
  return piModelRows(text).map((row) => row.id);
}


/** Async-iterate the lines of a child's stdout. */
function stdoutLines(proc: ReturnType<typeof spawn>): AsyncGenerator<string, void, unknown> {
  const stream = proc.stdout;
  if (!stream) throw new Error("pi: no stdout");
  return (async function* () {
    let buf = "";
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      buf += String(chunk);
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
      }
    }
    if (buf) yield buf;
  })();
}

function exitCode(proc: ReturnType<typeof spawn>): Promise<number | null> {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
  return new Promise((res) => proc.once("close", (rc) => res(rc)));
}
