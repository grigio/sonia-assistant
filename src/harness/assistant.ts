/**
 * Core assistant state + response lifecycle (history, approvals, model switching,
 * LLM → sentences → TTS → Player, announcer). The 32 ms frame loop lives in
 * `harness.ts` (class `Harness`).
 */

import fs from "node:fs";
import path from "node:path";
import { Config } from "../config";
import type { HistoryMessage, ServerEvent, StateName, TaskInfo } from "../events";
import { t, type ViaKey } from "../i18n";
import { estimateCharsPerToken, historyBudget, type ContextState } from "../context";
import { TTS, SmartTurn } from "../clients/audiocpp";
import { LLM, allowGateRetries, type ChatMessage, type StreamItem, type ToolCall } from "../clients/llm";
import { ToolMarkupFilter } from "../clients/toolmarkup";
import { toolEnd, toolStart, type ToolPayload } from "../clients/toolcards";
import { Player } from "../audio/player";
import type { MicSource } from "../audio/mic";
import { GATE_EXEMPT_TOOLS, Tools, argSummary, toolDescription } from "../tools";
import { Skills, type SkillInfo } from "../skills";
import { SileroVAD } from "../vad";
import { healthUrl, llmHealthUrl, probeAll, type Target } from "../health";
import { SentenceSplitter } from "./sentences";
import { ChatStore, type RestoredChat } from "./chat-store";
import { classifyYesNo } from "./text";
import { Logger } from "../log";
import {
  AsyncQueue,
  abortableIter,
  abortableSleep,
  isAbortError,
  now,
  withAbort,
} from "./queues";

export type Utterance = {
  gen: number;
  asr: import("../clients/audiocpp").LiveTranscription;
  tStart: number;
  lastSpeech: number;
  audio: Uint8Array[]; // chunks; concatenated on demand (Smart Turn)
  speechMs: number;
  pauseChecked: boolean;
  turnProb: number | null;
  decision: "pending" | "listen" | "speak" | null;
  decisionText: string;
  listenUntil: number;
  barge: boolean; // started while the assistant was talking
  partial: string;
};

export type Response = {
  userText: string;
  tUserDone: number;
  controller: AbortController;
  task: Promise<void> | null;
  spoken: string[];
  fullText: string;
  audioStarted: boolean;
  generationDone: boolean;
  historyIndex: number | null;
  /** Where this turn's user message sits in `history` (rollback point for "user continued"). */
  userIndex: number | null;
  tFirstToken: number | null;
  /**
   * Tool calls the gate denied earlier in *this* turn, keyed `name + args`. The judge
   * is deterministic (temperature 0, same words every round), so it would deny an
   * identical retry forever — `gateTools` allows the call on its second appearance.
   */
  denied: Map<string, number>;
  /**
   * Tools the gate already allowed for *this* user message. One request usually takes
   * several calls of the same tool (list → open one of the listed items, search → read
   * the thread, skill → its script): asking the judge again about the same tool only
   * burns a round (1.3-8.4 s measured, data/logs/harness.log 13:38:38-13:44:28) and, when the
   * model does not repeat the call verbatim, the call is simply lost and the assistant
   * answers from memory — with an invented item, as at 13:45:01.
   */
  gateAllowed: Set<string>;
};

type PendingApproval = { id: number; command: string; resolve: (ok: boolean) => void };

/** What a gated call answers the model instead of running (see `gateTools`). */
const toolGated = (cfg: Config): string => t(cfg.locale, "gated.tool");

/**
 * The head of a tool result, flattened to one line: what the tool gate's judge is shown
 * of the calls this answer already ran (it has to see that the next proposal continues
 * that same request — "list_skills → Skills (the user chooses…" is enough for it).
 */
function resultHead(result: string): string {
  const line = result.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line || "(empty)";
}

/**
 * How many requests of one turn may still carry the tools. The request *after* them
 * offers none, so a turn can only ever end on text — never on a tool call nobody ever
 * answers with a sentence (see `runResponse`).
 */
export const TOOL_ROUNDS = 6;

/**
 * Each liveness probe waits at most this long; the three run in parallel, so one round
 * of the health poll (`HEALTH_POLL_MS`) costs exactly it (see `src/health.ts`).
 */
const HEALTH_TIMEOUT_MS = 2_000;

/**
 * Two messages may share one history slot only when neither is part of a tool exchange:
 * gluing the final text onto a `tool_calls` message (or merging across results) leaves a
 * call without its answer in the *next* request.
 */
function mergeable(last: ChatMessage, msg: ChatMessage): boolean {
  if ((msg.role !== "user" && msg.role !== "assistant") || last.role !== msg.role) return false;
  return (
    !last.tool_calls?.length &&
    !msg.tool_calls?.length &&
    !last.tool_call_id &&
    !msg.tool_call_id
  );
}

/**
 * The history as the model gets it: two plain messages of the same role in a row — what
 * an unanswered question kept by ⟲ followed by the next question looks like — are glued
 * here, and only here. The transcript keeps the two apart (each line with its own
 * checkpoint id, so a later ⟲ cuts *between* them), while the chat template wants strict
 * user/assistant alternation. The glued message is a copy: the history's own messages —
 * and the ids they carry — are never touched.
 */
function forModel(history: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of history) {
    const last = out[out.length - 1];
    if (last && mergeable(last, m)) {
      out[out.length - 1] = {
        ...last,
        content: `${String(last.content ?? "")} ${String(m.content ?? "")}`,
      };
    } else out.push(m);
  }
  return out;
}

export class Assistant {
  readonly cfg: Config;
  readonly mic: MicSource | null;
  readonly playerSink: "pipewire" | "null" | "callback";
  readonly recordPath: string | null;

  /** The persona file verbatim; `systemPrompt` below adds the active skills on top. */
  private basePrompt: string;
  decisionPrompt: string;
  /** The tool gate's rules (`prompts/tool-gate.txt`), asked once per round of tool calls. */
  toolGatePrompt: string;
  /** Skill store: dir scan + the user's UI choice (created in `start()`). */
  skills: Skills | null = null;

  history: ChatMessage[] = [];
  /** `data/chat.json` while `CHAT_PERSIST` is on — created by `start()`, so an `Assistant`
   *  built directly by a test (no `start()`) writes nothing and restores nothing. */
  private chatStore: ChatStore | null = null;
  /** One warning per process: a full disk must not turn into a line per message. */
  private chatSaveFailed = false;
  /** History size (chars) and prompt tokens of the last real request: their ratio is the
   *  chars/token `fitHistory` scales the window budget with (see `context.ts`). */
  private lastPromptChars = 0;
  private lastPromptTokens = 0;
  utt: Utterance | null = null;
  resp: Response | null = null;
  gen = 0;
  speechRunMs = 0;
  preroll: Uint8Array[] = [];
  prerollMax: number;
  pendingPrefix = "";
  /**
   * Lines to say out of a turn (a timer ringing, a watch reporting), each with the key
   * of the task that produced it ("" = no task, nothing can withdraw it).
   */
  announcements: { key: string; text: string }[] = [];
  stats: { voice_to_audio_ms: number; voice_to_first_token_ms: number }[] = [];
  emit: (ev: ServerEvent) => void = () => {};
  state: StateName = "listening";
  /** audio.cpp servers the last liveness round could not reach: `asr` / `tts` / `turn`
   *  (plus `llm`, the one leg that is not audio.cpp — see `healthTargets`). */
  private healthDown: string[] = [];
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthBusy = false; // a slow round must never stack on the next tick
  /** The mic source died (see `Harness.runAudio`): nothing can be heard until it is back,
   *  so the orb says `offline` instead of sitting on `listening` with a silent input. */
  protected micDown = false;
  /** Set by `close()`: what tells a restarting loop and a pending task to give up. */
  protected stopped = false;
  pendingApproval: PendingApproval | null = null;
  models: string[] = [];
  /** Header context bar: tokens of the last LLM request (prompt + completion) / n_ctx. */
  contextUsed = 0;
  contextTotal = 0;
  private ctxKey = "";   // leg+model the cached `contextTotal` was resolved for

  llm!: LLM;
  tts!: TTS;
  turn!: SmartTurn;
  tools!: Tools;
  vad: SileroVAD | null = null;
  player!: Player;

  sentences: AsyncQueue<string | null> | null = null;

  private approvalSeq = 0;
  /** Bumped by resetConversation(): a turn stamped with an older epoch is old-chat data. */
  private epoch = 0;
  private readonly bg = new Map<AbortController, Promise<void>>();
  private readonly logger = new Logger();

  constructor(
    cfg: Config,
    mic: MicSource | null,
    playerSink: "pipewire" | "null" | "callback" = "pipewire",
    recordPath: string | null = null,
  ) {
    this.cfg = cfg;
    this.mic = mic;
    this.playerSink = playerSink;
    this.recordPath = recordPath;
    this.basePrompt = fs.readFileSync(cfg.systemPromptFile, "utf-8").trim();
    this.decisionPrompt = fs.readFileSync(cfg.decisionPromptFile, "utf-8").trim();
    this.toolGatePrompt = fs.readFileSync(cfg.toolGatePromptFile, "utf-8").trim();
    this.prerollMax = Math.max(1, Math.floor(cfg.prerollMs / 32));
  }

  /**
   * The system prompt actually sent to the model: the persona file plus a block with the
   * skills the user activated in the UI, and — always last — the locale's language default.
   * Nothing is autodiscovered: the prompt only ever names the active ones, and only when
   * there are tools to act on them (the pi leg brings its own skills and its own prompt
   * handling).
   *
   * The trailing line is what makes `LOCALE=en` actually answer in English: the persona's
   * "mirror the user" rule sits above the skills block, and a small model then drifts back
   * to Italian (5/5 English questions answered in Italian without it, 0/5 with it).
   */
  get systemPrompt(): string {
    const hint = t(this.cfg.locale, "prompt.langDefault");
    if (!this.cfg.llmEnableTools || this.cfg.llmViaPi || !this.skills) {
      return `${this.basePrompt}\n\n${hint}`;
    }
    return `${this.basePrompt}\n\n${this.skills.block()}\n\n${hint}`;
  }

  /** Skills as the settings drawer renders them: a fresh scan of SKILLS_DIR. */
  skillList(): SkillInfo[] {
    return this.skills ? this.skills.list() : [];
  }

  skillsDir(): string {
    return this.skills ? this.skills.dir : this.cfg.skillsDir;
  }

  /** The user ticked/unticked skills in the settings drawer → persist, broadcast, log. */
  setActiveSkills(active: string[]): void {
    if (!this.skills) return;
    const list = this.skills.setActive(active);
    const on = list.filter((s) => s.active).map((s) => s.name);
    this.emit({ type: "skills", dir: this.skills.dir, skills: list });
    this.log(`🧩 active skills: ${on.length ? on.join(", ") : "(none)"}`);
  }

  // ── TTS voice (the selector in the settings drawer) ──

  /** The voices the loaded TTS pack ships — one `<name>.safetensors` per file. The voice
   *  in use is always offered, even when the pack lives elsewhere (a custom server). */
  voiceList(): string[] {
    const names = new Set<string>([this.cfg.ttsVoice]);
    try {
      for (const f of fs.readdirSync(this.cfg.ttsVoicesDir)) {
        if (f.endsWith(".safetensors")) names.add(f.slice(0, -".safetensors".length));
      }
    } catch {
      /* no pack on disk → the configured voice is the only one we know of */
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  /** `data/voice`: the choice made in the drawer, honoured at the next start if valid. */
  private savedVoice(): string | null {
    try {
      const v = fs.readFileSync(path.join(this.cfg.dataDir, "voice"), "utf-8").trim();
      return v && this.voiceList().includes(v) ? v : null;
    } catch {
      return null;
    }
  }

  /** Restore the voice the user picked last time (called by `start()` before the TTS). */
  applySavedVoice(): string | null {
    const v = this.savedVoice();
    if (v) this.cfg.ttsVoice = v;
    return v;
  }

  /** The drawer picked another voice: switch the preset, remember it, warm it up. */
  setVoice(name: string): void {
    const voices = this.voiceList();
    const v = String(name ?? "").trim();
    if (!v || !voices.includes(v)) {          // never send a name the pack does not have
      this.log(`⚠ unknown voice: ${v || "(empty)"}`);
      this.emit({ type: "voices", voices, current: this.cfg.ttsVoice, rate: this.tts?.rate });
      return;
    }
    if (v === this.cfg.ttsVoice) return;
    this.cfg.ttsVoice = v;
    this.tts?.setVoice(v);
    try {
      fs.mkdirSync(this.cfg.dataDir, { recursive: true });
      fs.writeFileSync(path.join(this.cfg.dataDir, "voice"), `${v}\n`);
    } catch (e) {
      this.log(`⚠ voice choice not saved: ${e instanceof Error ? e.message : e}`);
    }
    this.log(`🔊 TTS voice → ${v}  (${this.tts?.rate ?? 24000} Hz)`);
    this.emit({ type: "voices", voices, current: v, rate: this.tts?.rate });
    void this.tts?.warmVoice();               // the preset loads now, not mid-sentence
  }

  // ── setup ──

  async start(): Promise<void> {
    this.logger.verbose = this.cfg.debug;
    this.llm = new LLM(this.cfg);
    this.restoreChat();       // the conversation of the previous run, ids and all
    this.applySavedVoice();   // the voice picked in the drawer last time, if the pack has it
    this.tts = new TTS(this.cfg.ttsUrl, this.cfg.ttsModel, this.cfg.ttsVoice);
    this.turn = new SmartTurn(this.cfg.turnUrl, this.cfg.turnModel);
    const skills = new Skills({ dir: this.cfg.skillsDir, dataDir: this.cfg.dataDir });
    this.skills = skills;
    this.tools = new Tools({
      dataDir: this.cfg.dataDir,
      announce: (text, key) => this.announce(text, key),
      withdraw: (key) => this.withdrawAnnouncements(key),
      approve: (c, r) => this.requestApproval(c, r),
      emit: (ev) => this.emit(ev as ServerEvent),
      cmdMode: this.cfg.cmdMode,
      cmdTimeoutS: this.cfg.cmdTimeoutS,
      epoch: () => this.epoch,          // lets Tools drop its late events after a 🧹
      locale: this.cfg.locale,          // a tool's result is shown on its card too
      skills,                           // list_skills / read_skill + the trusted skills dir
      history: () => this.history,      // "is that SKILL.md already in the context?"
      log: (m) => this.log(m),          // one English line per watch check (logs never switch)
    });
    const skillRows = skills.list();
    this.log(
      `🧩 skills ${skills.dir}: ` +
        `${skillRows.filter((s) => s.active).length}/${skillRows.length} active`,
    );
    this.vad = this.mic ? await new SileroVAD(this.cfg.vadModel).ready : null;

    const ids = await this.llm.check();
    this.models = ids;
    void this.syncContext(true); // the model lists just told us the n_ctx of this model
    if (!this.cfg.llmViaPi && !ids.includes(this.cfg.llmModel)) {
      this.log(
        `⚠ '${this.cfg.llmModel}' not listed by ${this.cfg.llmBaseUrl} ` +
          `(serves: ${ids.join(", ") || "nothing"}) — trying anyway`,
      );
    }
    if (this.cfg.llmViaPi) {
      this.log(
        `LLM  via pi: ${this.cfg.piCmd}  cwd=${this.cfg.piCwd}  ` +
          `model=${this.cfg.piModel || "pi's default"}  (warming up…)`,
      );
    } else {
      this.log(`LLM  ${this.cfg.llmBaseUrl}  model=${this.cfg.llmModel}  (warming up…)`);
    }
    if (this.llm.judgeDedicated) {
      this.log(`⚖ judge ${this.llm.judgeBase}  model=${this.llm.judgeModel}`);
    }

    const [rate] = await Promise.all([
      this.tts.detectRate(),
      this.llm.warmup(this.systemPrompt),
      this.warmupAsr(),
      // Prime the judge's own prefix too, so the first real pause answers warm. A
      // failing judge only degrades turn-taking (decide() falls back to «speak»),
      // so a warning, never a fatal startup error.
      this.llm.warmupJudge(this.decisionPrompt).catch((e) =>
        this.log(`⚠ judge warmup failed: ${e instanceof Error ? e.message : e}`),
      ),
    ]);
    this.log(`TTS  ${this.cfg.ttsUrl}  voice=${this.cfg.ttsVoice}  ${rate} Hz`);
    this.log(
      `ASR  ${this.cfg.asrUrl}  turn=${this.cfg.turnUrl}  decision=${this.cfg.decisionMode}`,
    );

    this.player = new Player(
      rate,
      this.cfg.spkTarget,
      this.cfg.playbackLatencyMs,
      this.playerSink,
      this.recordPath,
    );
    this.player.onSegmentStart = (tag) => this.onSegmentStart(tag);
    this.player.onIdle = () => this.onIdle();
    await this.player.start();
    this.startHealthPoll();
  }

  /** First live session allocates the Vulkan graphs (~seconds): do it now. */
  private async warmupAsr(): Promise<void> {
    if (!this.mic) return;
    const { LiveTranscription } = await import("../clients/audiocpp");
    const lt = new LiveTranscription(this.cfg.asrUrl, this.cfg.asrModel, this.cfg.asrLanguage);
    await lt.open();
    lt.send(new Uint8Array(16000 * 2));
    await lt.finish(0, 60_000);
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.stopHealthPoll();
    this.resp?.controller.abort();
    this.utt?.asr.abort();
    for (const ctl of [...this.bg.keys()]) ctl.abort();
    await Promise.allSettled([...this.bg.values()]);
    if (this.mic) await this.mic.close();
    await this.player?.close();
    this.tools?.close();
  }

  // ── logging ──

  log(msg: string): void {
    this.logger.log(msg);
  }

  status(msg: string): void {
    this.logger.status(msg);
  }

  // ── state ──

  setState(state: StateName): void {
    if (state !== this.state) {
      this.state = state;
      this.emit({ type: "state", state });
    }
  }

  refreshState(): void {
    // A dead ASR/TTS/LLM (or a dead mic source) outranks everything else: nothing can be
    // transcribed, answered or spoken, so the honest headline is `offline` whatever the
    // pipeline was doing (health.ts).
    if (
      this.micDown ||
      this.healthDown.includes("asr") ||
      this.healthDown.includes("tts") ||
      this.healthDown.includes("llm")
    ) {
      this.setState("offline");
    } else if (this.pendingApproval !== null && this.utt === null) this.setState("confirm");
    else if (this.utt !== null) this.setState("user");
    else if (this.resp !== null) {
      this.setState(
        this.player?.paused ? "paused" : this.player?.audible ? "speaking" : "thinking",
      );
    } else this.setState("listening");
  }

  // ── audio.cpp liveness (health.ts) ──

  /**
   * The mic source went away (`pw-record` died, the device was unplugged) and came back.
   * Down: the orb goes `offline`, the line is said in the chat — and the utterance in
   * flight is dropped, so a half-heard turn cannot be flushed as a garbage transcript
   * minutes later when the audio resumes.
   */
  setMicDown(down: boolean): void {
    if (this.micDown === down) return;
    this.micDown = down;
    if (down) {
      this.log("⚠ mic source down — waiting for it to come back");
      this.emit({ type: "event", text: t(this.cfg.locale, "evt.micDown") });
      if (this.utt !== null) {
        this.utt.asr.abort();
        this.utt = null;
        this.preroll = [];
        this.speechRunMs = 0;
        this.vad?.reset();
      }
    } else {
      this.log("✅ mic source back");
      this.emit({ type: "event", text: t(this.cfg.locale, "evt.micBack") });
    }
    this.refreshState();
  }

  private healthTargets(): Target[] {
    const targets: Target[] = [
      { name: "asr", url: healthUrl(this.cfg.asrUrl) },
      { name: "tts", url: healthUrl(this.cfg.ttsUrl) },
      { name: "turn", url: healthUrl(this.cfg.turnUrl) },
    ];
    // The LLM leg is liveness-checked too: a dead llama-server used to leave the orb green
    // and the user with raw `fetch failed` lines. The pi leg is a subprocess — nothing to
    // probe (and `pi` is only spawned on a turn anyway).
    if (!this.cfg.llmViaPi) targets.push({ name: "llm", url: llmHealthUrl(this.cfg.llmBaseUrl) });
    return targets;
  }

  /**
   * One liveness round: log *which* server moved (the log is the record, the state only
   * says "offline"), then re-derive the state — `refreshState()` puts the UI on `offline`
   * while ASR or TTS is unreachable and back on the real state once they answer.
   */
  private async pollHealth(): Promise<void> {
    if (this.healthBusy) return;
    this.healthBusy = true;
    try {
      const targets = this.healthTargets();
      const down = await probeAll(targets, HEALTH_TIMEOUT_MS);
      const wasDown = new Set(this.healthDown);
      const isDown = new Set(down);
      if (wasDown.size === isDown.size && [...wasDown].every((n) => isDown.has(n))) return;
      for (const { name, url } of targets) {
        if (isDown.has(name) === wasDown.has(name)) continue;
        const what = name === "llm" ? "LLM" : "audio server";
        this.log(isDown.has(name) ? `⚠ ${what} down: ${name} ${url}` : `✅ ${what} back: ${name} ${url}`);
      }
      this.healthDown = down;
      this.refreshState();
    } catch (e) {
      this.log(`[health] ${e}`);
    } finally {
      this.healthBusy = false;
    }
  }

  /** Start the liveness loop (the warmups in `start()` just proved the servers up). */
  private startHealthPoll(): void {
    this.stopHealthPoll();
    if (this.cfg.healthPollMs <= 0) return; // HEALTH_POLL_MS=0: no poller at all
    void this.pollHealth(); // …this first round catches one that died in between
    this.healthTimer = setInterval(() => void this.pollHealth(), this.cfg.healthPollMs);
    this.healthTimer.unref?.(); // the poller must never be what holds the process open
  }

  private stopHealthPoll(): void {
    if (this.healthTimer !== null) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  // ── model switching ──

  async switchModel(model: string): Promise<void> {
    const cfg = this.cfg;
    const usePi = cfg.llmViaPi;
    const old = usePi ? cfg.piModel : cfg.llmModel;
    if (model === old) return;
    if (this.resp) this.cancelResponse(true);
    if (usePi) cfg.piModel = model;
    else cfg.llmModel = model;
    this.log(`🔁 switching LLM ${old} → ${model} (loading…)`);
    this.emit({ type: "model_loading", model });
    this.setState("thinking");
    const t0 = now();
    let loaded = true;
    try {
      await this.llm.warmup(this.systemPrompt);
    } catch (e) {
      loaded = false;
      if (usePi) cfg.piModel = old;
      else cfg.llmModel = old;
      this.log(`[model] failed to load ${model}: ${e} — back to ${old}`);
      this.emit({
        type: "model_error",
        model,
        current: old,
        error: String(e).slice(0, 300),
      });
    }
    if (loaded) {
      const secs = now() - t0;
      this.log(`✅ LLM ${model} ready in ${secs.toFixed(1)} s`);
      this.emit({ type: "model_ready", model, seconds: Math.round(secs * 10) / 10 });
      // without DECISION_* the judge follows the conversation's model: its freshly
      // loaded prefix needs priming again (warning only — same policy as startup)
      if (!this.llm.judgeDedicated)
        this.llm.warmupJudge(this.decisionPrompt).catch((e) =>
          this.log(`⚠ judge warmup failed: ${e instanceof Error ? e.message : e}`),
        );
    }
    void this.syncContext(true); // a new model → a new context window (or the old one back)
    this.refreshState();
  }

  // ── shell-command approval (voice or click) ──

  async requestApproval(command: string, reason: string): Promise<boolean> {
    this.approvalSeq++;
    const id = this.approvalSeq;
    let resolveFn: (ok: boolean) => void = () => {};
    const promise = new Promise<boolean>((res) => (resolveFn = res));
    this.pendingApproval = { id, command, resolve: resolveFn };
    this.log(`   ❓ approve command? $ ${command}` + (reason ? `   (${reason})` : ""));
    this.emit({ type: "command_request", id, command, reason });
    if (this.sentences !== null) {
      await this.sentences.push(t(this.cfg.locale, "spoken.approveCommand"));
    }
    this.refreshState();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<boolean>((res) => {
        timer = setTimeout(() => {
          timedOut = true;
          res(false);
        }, this.cfg.cmdApprovalTimeoutS * 1000);
      });
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
      if (timedOut) this.log("   ⌛ approval timed out → denied");
      if (this.pendingApproval && this.pendingApproval.id === id) this.pendingApproval = null;
      this.emit({ type: "command_resolved", id });
      this.refreshState();
    }
  }

  resolveApproval(
    ok: boolean,
    approvalId: number | null = null,
    viaKey: ViaKey | null = null,
    viaText = "",
  ): boolean {
    const pa = this.pendingApproval;
    if (pa === null || (approvalId !== null && approvalId !== pa.id)) return false;
    this.player.flush(); // stop the spoken question
    const resolve = pa.resolve;
    this.pendingApproval = null;
    // the chat line follows LOCALE, the log line is always English (logs never switch language)
    const shown = viaKey ? t(this.cfg.locale, viaKey) : viaText;
    const logged = viaKey ? t("en", viaKey) : viaText;
    this.log(`   ${ok ? "✅ approved" : "❌ denied"}${logged ? " " + logged : ""}: $ ${pa.command}`);
    this.emit({
      type: "event",
      text:
        t(this.cfg.locale, ok ? "evt.cmdApproved" : "evt.cmdDenied") +
        (shown ? ` (${shown})` : ""),
    });
    resolve(ok);
    return true;
  }

  /** A spoken/typed reply while a command waits for approval. True if consumed. */
  answerApprovalText(text: string): boolean {
    if (this.pendingApproval === null) return false;
    const verdict = classifyYesNo(text);
    if (verdict === null) {
      // something else entirely: deny and let it become a normal turn
      this.resolveApproval(false, null, "via.unclear");
      return false;
    }
    return this.resolveApproval(verdict === "yes", null, null, `«${text}»`);
  }

  // ── conversation lifecycle ──

  resetConversation(): void {
    // 🧹 first the epoch, so everything still in flight (tool results, late text,
    // denied approvals) is recognised as old-chat data and dropped instead of
    // resurfacing in the chat the user just erased
    this.epoch++;
    // 🧹 wipes the conversation, not the world: pending timers, their banner chips and a
    // ring that is already due all stay — a timer is a promise made to the *user*, and
    // wiping it with the chat is how a 15-minute timer silently never rang
    // (data/logs/harness.log 19:32:56, 🧹 19:41:45). Tools.close() is what ends them.
    if (this.pendingApproval) this.resolveApproval(false, null, "via.cleaned");
    if (this.resp) this.cancelResponse(false);
    if (this.utt) {
      this.utt.asr.abort();
      this.utt = null;
    }
    this.history = [];
    this.persistChat();   // 🧹 empties the file too: a restart must not resurrect the chat
    this.pendingPrefix = "";
    this.contextUsed = 0;   // the conversation is empty again: the bar goes back to zero
    this.emitContext();
    if (this.cfg.llmViaPi) this.llm.resetSession(); // pi remembers too: fresh session
    this.vad?.reset();
    this.refreshState();
  }

  /** Client went away: stop talking/listening but keep the conversation. */
  stopActivity(): void {
    if (this.resp) this.cancelResponse(true);
    if (this.utt) {
      this.utt.asr.abort();
      this.utt = null;
    }
    this.speechRunMs = 0;
    this.vad?.reset();
    this.refreshState();
  }

  /** Port of `spawn()`: run a background task, log failures, track for cancellation. */
  spawn(fn: (signal: AbortSignal) => Promise<void>): AbortController {
    const ctl = new AbortController();
    const p = fn(ctl.signal).catch((e) => {
      if (!isAbortError(e)) this.log(`[error] ${String(e)}`);
    });
    this.bg.set(ctl, p);
    p.finally(() => this.bg.delete(ctl));
    return ctl;
  }

  // ── the banner above the chat (pending timers / running commands) ──

  /** The chip list: what a freshly opened page gets in its `hello`, sent live since. */
  tasks(): TaskInfo[] {
    return this.tools?.tasks() ?? [];
  }

  /**
   * ✕ on one chip: stop that one task, say it in the chat (the user's language) and in the
   * log (English — logs never switch language). `null` = nothing to cancel, so the caller
   * stays silent rather than announcing a task that is already gone.
   */
  cancelTask(id: string): TaskInfo | null {
    // a timer is cancelled in the language its own request was in, like its ring
    const loc = this.tools?.taskLocale(id) ?? this.cfg.locale;
    const task = this.tools?.cancelTask(id) ?? null;
    if (!task) return null;
    const key =
      task.kind === "timer"
        ? "task.cancelTimer"
        : task.kind === "watch"
          ? "task.cancelWatch"
          : "task.cancelCommand";
    // both lines clip the same way: a command can be a whole shell line
    const head = resultHead(task.label);
    this.log(`⏹ ${t("en", key, { label: head })}`);
    this.emit({ type: "event", text: t(loc, key, { label: head }) });
    return task;
  }

  // ── context meter (the bar next to the title) ──

  contextState(): ContextState {
    return { used: this.contextUsed, total: this.contextTotal };
  }

  emitContext(): void {
    this.emit({ type: "context", ...this.contextState() });
  }

  /**
   * Re-read n_ctx for the active leg+model and tell the UI. Cheap by design: the number
   * comes from the model list `check()` already fetched, so this is a lookup unless the
   * model (or the leg) actually changed. `total = 0` means "unknown" → the bar hides itself.
   */
  async syncContext(force = false): Promise<void> {
    const cfg = this.cfg;
    const key = `${cfg.llmViaPi ? "pi" : "api"}\u0000${cfg.llmViaPi ? cfg.piModel : cfg.llmModel}`;
    if (!force && key === this.ctxKey) {
      this.emitContext();
      return;
    }
    this.ctxKey = key;
    let total = 0;
    try {
      total = await this.llm.contextWindow();
    } catch (e) {
      this.log(`[context] ${e}`);
    }
    this.contextTotal = total > 0 ? Math.trunc(total) : 0;
    this.emitContext();
  }

  /** A finished LLM request: prompt + completion is the context it just occupied. */
  private onUsage(prompt: number, completion: number): void {
    const used = Math.round(prompt) + Math.round(completion);
    if (used <= 0) return;               // provider reported nothing → keep the last real figure
    this.contextUsed = used;
    // …and the tokenizer's own verdict on the prompt we just measured in chars
    if (prompt > 0) this.lastPromptTokens = Math.round(prompt);
    void this.syncContext();
  }

  // ── the conversation on disk (data/chat.json) ────────────────────────────

  /**
   * Restore last run's conversation: the transcript the page draws, the model's history
   * and the checkpoint id of every line (⟲ works across a restart). `CHAT_PERSIST=0`
   * keeps the old behaviour of starting empty.
   *
   * Called by `start()` — and it is what *arms* the store: an `Assistant` built directly
   * (every unit test) saves nothing until this runs, so the test suite never touches a
   * real `data/chat.json`. It is a no-op with nothing to restore, which is why a test
   * calls it too, to switch saving on.
   */
  restoreChat(): void {
    if (!this.cfg.chatPersist) return;
    const store = new ChatStore(path.join(this.cfg.dataDir, "chat.json"));
    this.chatStore = store;
    let saved: RestoredChat | null = null;
    try {
      saved = store.load();
    } catch (e) {
      this.log(`⚠ chat restore failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    if (saved === null) return;
    this.history = saved.entries.map((e) => e.msg);
    for (const e of saved.entries) this.ids.set(e.msg, e.id);
    this.msgSeq = Math.max(this.msgSeq, saved.maxId);   // new ids keep being unique
    this.dropOpenTools();   // a run that died mid-exchange leaves a call with no answer
    this.log(
      `💾 chat restored: ${this.history.length} message(s), ` +
        `${this.chatLines().length} chat line(s)`,
    );
    this.persistChat();     // the pruned version is what stays on disk
  }

  /** Write the conversation. A no-op while there is no store (see `chatStore`). */
  private persistChat(): void {
    const store = this.chatStore;
    if (store === null) return;
    try {
      store.save(this.history, this.ids);
      this.chatSaveFailed = false;
    } catch (e) {
      if (!this.chatSaveFailed) {
        this.chatSaveFailed = true;
        this.log(`⚠ chat not saved: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /** The history's size in the units the context budget is written in. */
  private historyChars(): number {
    return this.history.reduce((n, m) => n + JSON.stringify(m).length + 4, 0);
  }

  // ── history ──

  /**
   * **Checkpoints**: one id per history message, what the ⟲ button on a chat line points
   * at (`rewindTo` below). A WeakMap rather than a field *on* the message, because
   * `JSON.stringify(messages)` is what reaches the model and what `--stats` writes — the
   * id must not travel — and because a message that leaves the history then simply loses
   * its id: a stale checkpoint resolves to nothing instead of to whatever now sits at its
   * old index (indexes shift, `fitHistory` drops the oldest turn).
   */
  private readonly ids = new WeakMap<ChatMessage, number>();
  /** Never reset, not even by 🧹: ids must stay unique for the life of the process. */
  private msgSeq = 0;

  /** Both ways a message enters `history` go through here (`addMessage`, `keep`). */
  private stamp(msg: ChatMessage): ChatMessage {
    this.ids.set(msg, ++this.msgSeq);
    return msg;
  }

  /**
   * Assistant lines merge as they always did (an answer and a line the assistant speaks on
   * its own); a **user** line never does: ⟲ points at one line of the transcript, and
   * gluing the next question onto an unanswered one would leave both carrying the same
   * checkpoint id. The strict user/assistant alternation Gemma's template requires is
   * restored where the request is built (`forModel`), not here.
   */
  addMessage(msg: ChatMessage): number {
    const last = this.history[this.history.length - 1];
    if (last && msg.role === "assistant" && mergeable(last, msg)) {
      last.content = String(last.content ?? "") + " " + String(msg.content ?? "");
      this.persistChat();   // its text changed — the file keeps what the model will get
      return this.history.length - 1;
    }
    this.history.push(this.stamp(msg));
    this.persistChat();
    return this.history.length - 1;
  }

  /**
   * The conversation as the transcript shows it: the user/assistant lines only, each with
   * its checkpoint id. Sent in `hello` and again in every `chat_rewound` — the second one
   * is what lets the page cut its own DOM exactly where the server cut the history.
   *
   * A message with no text of its own (a bare `tool_calls` round) has no line in the chat
   * and never leaves here: its payload must not leak into the transcript.
   */
  chatLines(): HistoryMessage[] {
    const out: HistoryMessage[] = [];
    for (const m of this.history) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      if (typeof m.content !== "string") continue;
      const id = this.ids.get(m);
      if (id === undefined) continue;
      out.push({ role: m.role, content: m.content, id });
    }
    return out;
  }

  // ── history hygiene ──

  /**
   * A turn can be cut between a `tool_calls` message and its results (barge-in, a 🧹, a
   * dropped approval): a tool call with no answer is not something a chat template accepts.
   * Walk back from the end; if the newest exchange is only half there, cut the whole thing
   * off — the call and its partial results go together, so nothing is left dangling.
   */
  private dropOpenTools(): void {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i]!;
      if (m.role === "tool") continue; // collect the results of the exchange being checked
      if (m.role !== "assistant" || !m.tool_calls?.length) return; // a normal line: nothing open
      let done = 0;
      for (let j = i + 1; j < this.history.length; j++) {
        if (this.history[j]!.role === "tool") done++;
      }
      if (done >= m.tool_calls.length) return; // every call got its result
      this.history.length = i;                 // half an exchange → drop it whole
      this.persistChat();
      return;
    }
  }

  /**
   * Keep the history inside the model's window. Tool results (a SKILL.md, a command's
   * output) are an order of magnitude bigger than chat lines, so a long session can outgrow
   * n_ctx even though every single turn looked harmless. Oldest turns go first — never half
   * an exchange (whole turns only), never the turn being answered now. No-op while n_ctx is
   * unknown: there is nothing sensible to fit into.
   */
  private fitHistory(): void {
    // The budget (context.ts): n_ctx when a model list reports it — and a conservative
    // assumed window when it does not, because "n_ctx unknown" used to mean "never trim",
    // i.e. the history grew until llama-server refused the request. The chars/token ratio
    // is measured from the last real request instead of guessed (≈3), so a history full
    // of shell output is sized by the tokenizer that will actually read it.
    const budget = historyBudget(
      this.contextTotal,
      estimateCharsPerToken(this.lastPromptChars, this.lastPromptTokens),
    );
    const size = () => this.historyChars();
    if (size() <= budget) return;
    const before = this.history.length;
    for (;;) {
      let secondUser = -1;
      let seen = 0;
      for (let i = 0; i < this.history.length; i++) {
        if (this.history[i]!.role !== "user") continue;
        if (++seen === 2) {
          secondUser = i;
          break;
        }
      }
      if (secondUser < 1) break; // only the current turn is left
      this.history.splice(0, secondUser); // the oldest turn, exchange and all
      if (size() <= budget) break;
    }
    if (this.history.length < before) {
      this.log(`✂ history ${before} → ${this.history.length} messages (context window)`);
      this.persistChat();   // the trimmed history is the one a restart must come back to
    }
  }

  /**
   * ⟲ **Rewind the conversation to a checkpoint**: keep that history message and
   * everything before it, drop everything after it. 🧹 erases the whole chat, this erases
   * only the part the user is sorry about — the older turns, and the context they take up,
   * survive.
   *
   * Follows `resetConversation` step by step where the two overlap (epoch first, so a tool
   * result or a command card still on its way from the dropped part is recognised as
   * old-chat data; approval denied; the in-flight turn cancelled; pi's session rebuilt),
   * and then cuts:
   *
   *  - the checkpoint and everything before it (`keep`), never a bare index handed over by
   *    the page: the id is looked up in *this* history, so a stale one is a no-op (`false`)
   *    instead of a wrong cut;
   *  - **never the line the button sits on**: ⟲ on your own unanswered question keeps the
   *    question (the next one is glued onto it *on the wire*, by `forModel`, so the two
   *    lines keep their own checkpoints), and a line whose own tool results the cut took
   *    keeps its text — the calls go, they have no answers left;
   *  - `dropOpenTools()` after the cut, because the boundary may fall between a
   *    `tool_calls` message and its results (a call no template accepts);
   *  - a trailing **user** line that is *not* the checkpoint too: a question nobody
   *    answered is not context, and the next user line would land on it as one turn.
   *
   * Pending timers/watches are left alone, exactly as 🧹 leaves them: a timer is a promise
   * made to the user, not a piece of the chat.
   *
   * `false` = no such checkpoint (stale page): nothing at all is touched.
   */
  rewindTo(id: number): boolean {
    const at = this.history.findIndex((m) => this.ids.get(m) === id);
    if (at < 0) return false;
    // the clicked line and everything before it, taken *before* anything is cancelled:
    // `cancelResponse` cuts the in-flight turn off the end of the history, but the cut of
    // a ⟲ is the checkpoint's — a line the user just kept is put back by the splice below
    const keep = this.history.slice(0, at + 1);
    const target = keep[keep.length - 1]!;
    const before = this.history.length;
    // ⟲ the epoch first, like 🧹: everything still in flight belongs to the part of the
    // conversation that is about to disappear
    this.epoch++;
    if (this.pendingApproval) this.resolveApproval(false, null, "via.rewound");
    if (this.resp) this.cancelResponse(false, true); // the turn being answered is past the target
    if (this.utt) {
      this.utt.asr.abort();
      this.utt = null;
    }
    this.pendingPrefix = "";   // half a sentence the user never finished: it goes with it
    this.history.splice(0, this.history.length, ...keep);
    // the cut took the results of the target's own tool calls with it: those calls go too
    // (a `tool_calls` message with no answer is not something a template accepts) — but
    // the line itself is the one the user pointed at, so it stays, as plain text
    if (target.role === "assistant" && target.tool_calls?.length) {
      delete target.tool_calls;
      if (typeof target.content !== "string" || !target.content.trim()) this.history.pop();
    }
    this.dropOpenTools();
    while (
      this.history.length &&
      this.history[this.history.length - 1]!.role === "user" &&
      this.history[this.history.length - 1] !== target
    ) {
      this.history.length--;   // …and no dangling question — but never the clicked line
    }
    // pi's own session cannot be cut: move on to conv<n+1> and re-seed it with what is left
    if (this.cfg.llmViaPi) this.llm.rewindSession();
    this.vad?.reset();
    // `contextUsed` stays as it is: it is what the *last request* put in the KV cache, and
    // the size of the next prompt is unknowable until it is sent (it corrects itself then)
    this.log(`⟲ history ${before} → ${this.history.length} messages (rewound to #${id})`);
    this.persistChat();   // ⟲ must survive a restart like the rest of the conversation
    this.refreshState();
    return true;
  }

  // ── responses ──

  /**
   * Start the answer to one user line.
   *
   * The `user` event is emitted *here*, not by the caller: its checkpoint id only exists
   * once the line is in `history`, and the line must be recorded — and announced — after
   * the `cancelResponse` above, so the previous answer's "interrupted" marker lands on the
   * bubble it belongs to. `info` is the dim line the chat shows under the message
   * (`user.typed`, `user.turnEnd`, …).
   */
  startResponse(userText: string, tUserDone: number, info?: string): void {
    if (this.resp !== null) this.cancelResponse(true);
    const controller = new AbortController();
    const resp: Response = {
      userText,
      tUserDone,
      controller,
      task: null,
      spoken: [],
      fullText: "",
      audioStarted: false,
      generationDone: false,
      historyIndex: null,
      userIndex: null,
      tFirstToken: null,
      denied: new Map(),
      gateAllowed: new Set(),
    };
    const userIndex = this.addMessage({ role: "user", content: userText });
    resp.userIndex = userIndex;
    this.emit({ type: "user", text: userText, info, id: this.ids.get(this.history[userIndex]!) });
    this.resp = resp;
    resp.task = this.runResponse(resp);
    this.responseTaskDone(resp, resp.task);
  }

  private responseTaskDone(resp: Response, task: Promise<void>): void {
    task.then(
      () => {
        if (this.resp === resp && !this.player.busy) this.finishResponse(resp);
      },
      (err) => {
        if (isAbortError(err)) return;
        if (resp.controller.signal.aborted) return;   // cancelled (or 🧹): no stale warning line
        this.log(`[response] ${String(err)}`);
        this.emit({ type: "event", text: `⚠ ${err}` });
        if (this.resp === resp) this.resp = null;
        // …and re-derive the state: without this the orb stayed on thinking/speaking for
        // a turn that is already over (nothing else refreshes once `resp` is gone)
        this.refreshState();
      },
    );
  }

  onTool(ev: ToolPayload): void {
    const name = ev.tool ?? "?";
    const origin = ev.origin ?? "";
    if (ev.phase === "start") {
      const tail = ev.summary ? ` ${ev.summary}` : "";
      const who = origin && origin !== "harness" ? `${origin} · ` : "";
      this.log(`   🔧 ${who}${name}${tail}`);
    } else {
      // three outcomes on the card and in the log: ⚠ ran and failed, ⛔ refused by the
      // gate (never ran), ⚙ ran fine — the middle one used to be logged as ⚙ too
      const mark = ev.error ? "⚠" : ev.blocked ? "⛔" : "⚙";
      const head = `   ${mark} ${name} → ${String(ev.result ?? "").replace(/\n/g, " ").slice(0, 120)}`;
      this.log(head + (ev.info ? `   (${ev.info})` : ""));
    }
    this.emit({ type: "tool", ...ev });
  }
  private async runResponse(resp: Response): Promise<void> {
    const signal = resp.controller.signal;
    const epoch = this.epoch;           // 🧹 mid-turn → everything below is old-chat data
    const stale = () => epoch !== this.epoch || signal.aborted;
    const sentences = new AsyncQueue<string | null>();
    const ttsCtl = new AbortController();
    const ttsTask = this.ttsWorker(sentences, ttsCtl.signal);
    // The handler has to be attached *here*: a TTS request can be refused while the LLM
    // is still streaming, and Bun exits on a rejection nobody has subscribed to yet — a
    // dead :8092 killed the whole harness instead of failing this one response.
    let ttsError: unknown = null;
    const ttsDone = ttsTask.catch((e) => {
      ttsError = e;
    });
    try {
      this.dropOpenTools(); // a turn cut mid-exchange must not go out in the request
      this.fitHistory();     // …and the whole history has to fit the window
      const messages: ChatMessage[] = [
        { role: "system", content: this.systemPrompt },
        ...forModel(this.history), // two kept questions in a row are one turn *here* only
      ];
      // in pi mode pi brings its own tools (bash, read, edit…)
      const tools =
        this.cfg.llmEnableTools && !this.cfg.llmViaPi ? this.tools.schemas() : null;
      this.sentences = sentences;
      const splitter = new SentenceSplitter();
      // a tool call written as *text* (no tools on offer) must never be spoken nor kept
      const markup = new ToolMarkupFilter();
      // A tool exchange has to survive the turn: `messages` is rebuilt from `this.history`
      // on every request, so a SKILL.md stored only in this array would vanish with it and
      // the model would read the same skill all over again on the next turn.
      const keep = (msg: ChatMessage): boolean => {
        if (stale()) return false; // no `await` between the check and the push
        messages.push(msg);
        this.history.push(this.stamp(msg));
        this.persistChat();
        return true;
      };
      // The turn must never *end* on a tool call: `TOOL_ROUNDS` requests may offer the
      // tools, the next one cannot, so the loop can only exit on text. Ending right
      // after the 4th call used to leave the user with nothing — no sentence spoken and
      // an empty assistant line in the history (data/logs/*.log: four run_command rounds, then
      // a bare "🤖 ", the user replying "puoi rispondere?").
      let round = 0;
      /** One line per call this turn already ran: what the tool gate's judge is shown. */
      const doing: string[] = [];
      for (;;) {
        const offer = round < TOOL_ROUNDS ? tools : null;
        round++;
        // The tool-less request says so in words as well: with the schema gone, a small
        // model continues a tool chain it can no longer call by writing the call as
        // plain text ("<toolcall <function=runcommand …"), which the TTS would read aloud
        // and the mic would then recognise as a *user* turn.
        if (offer === null && tools !== null) {
          messages.push({ role: "user", content: t(this.cfg.locale, "prompt.answerNow") });
        }
        // what this request's `prompt_tokens` will be describing: the ratio
        // `historyChars / prompt tokens` is what sizes the trim of the *next* turn
        this.lastPromptChars = this.historyChars();
        let textRound = "";
        let calls: ToolCall[] | null = null;
        let reasoningStarted = false; // one blank line before each extra round's thinking
        for await (const item of abortableIter(this.llm.stream(messages, offer), signal) as AsyncGenerator<StreamItem>) {
          if (item.kind === "reasoning") {
            if (stale()) return;
            if (!reasoningStarted) {
              reasoningStarted = true;
              if (round > 1) this.emit({ type: "reasoning", text: "\n" }); // round is 1-based
            }
            // 💭 thinking: shown in the UI (collapsed), never spoken nor kept in history
            this.emit({ type: "reasoning", text: item.text });
          } else if (item.kind === "text") {
            if (resp.tFirstToken === null) resp.tFirstToken = now();
            const clean = markup.feed(item.text);
            if (clean) {
              textRound += clean;
              for (const s of splitter.feed(clean)) sentences.push(s);
            }
          } else if (item.kind === "event") {
            if (stale()) return;
            this.log(item.note);
            this.emit({ type: "event", text: item.note });
          } else if (item.kind === "tool") {
            if (stale()) return;
            this.onTool(item.tool);
          } else if (item.kind === "usage") {
            if (!stale()) this.onUsage(item.prompt, item.completion);
          } else {
            calls = item.calls;
          }
        }
        const tail = markup.flush(); // the last held-back piece of this round's text
        if (tail) {
          textRound += tail;
          for (const s of splitter.feed(tail)) sentences.push(s);
        }
        resp.fullText += textRound;
        if (!calls) break;
        if (offer === null) {
          // the final request carries no tools, so a call here has nothing to run
          // against: drop it rather than leave an unanswered exchange in the history
          this.log(`⚠ ${calls.length} tool call(s) with none on offer — dropped`);
          break;
        }
        if (!keep({ role: "assistant", content: textRound || null, tool_calls: calls })) return;
        // the judge re-checks this round against the user's actual words: a small model
        // offered tools re-runs the previous turn's tool for any vague follow-up
        const allowed = await this.gateTools(calls, resp, doing);
        for (let i = 0; i < calls.length; i++) {
          const c = calls[i]!;
          if (stale()) return;
          const name = c.function.name;
          const raw = c.function.arguments;
          const callId = c.id || "";
          const gated = allowed !== null && !allowed.has(i);
          this.onTool(toolStart("harness", callId, name, raw));
          const t0 = now();
          // `langHint` is this turn's user text: a timer rings minutes later, so it keeps
          // the language it was asked in («Il Saluto finale è scaduto.», not "The …")
          const result = gated
            ? toolGated(this.cfg)
            : await this.tools.call(name, raw, signal, resp.userText);
          if (stale()) return;          // 🧹 while it ran: its result must not reach the new chat
          // what this answer is *already* doing — the judge needs it to see that the next
          // proposal continues the same request instead of starting something of its own
          if (!gated) doing.push(`${name} ${argSummary(raw)} → ${resultHead(result)}`);
          // run_command's result opens with "exit code <rc>" (tools.ts): a non-zero rc is a
          // failure, and the card must read "⚠ error", never "✅ ok" — the pi leg already
          // gets this right through pi's isError flag
          const failed = !gated && /^exit code [1-9]\d*\b/m.test(result);
          this.onTool(
            toolEnd(
              "harness",
              callId,
              name,
              result,
              gated ? t(this.cfg.locale, "tool.gatedInfo") : `${(now() - t0).toFixed(2)} s`,
              failed,
              gated, // ⛔ the card must not read "✅ ok" for a call that never ran
            ),
          );
          if (!keep({ role: "tool", tool_call_id: c.id || "0", content: result })) return;
        }
      }
      if (markup.seen) {
        this.log(
          `⚠ tool-call markup in the model's text — dropped ${markup.droppedChars} chars`,
        );
      }
      for (const s of splitter.flush()) sentences.push(s);
      let text = SentenceSplitter.clean(resp.fullText);
      if (!text) {
        // Even the tool-less round came back empty. Silence is not an answer: speak a
        // line of our own, and keep the history off an empty assistant message (strict
        // user/assistant alternation — see `addMessage`).
        text = t(this.cfg.locale, "spoken.noAnswer");
        this.log(`⚠ ${round} requests, no text — fallback: ${text}`);
        sentences.push(text);
      }
      sentences.push(null);
      this.sentences = null;
      await ttsDone;
      if (stale()) return;              // cleaned/interrupted while TTS played → keep it out of history
      if (ttsError !== null) throw ttsError; // → responseTaskDone: log + ⚠ line + turn cleared
      const answerIndex = this.addMessage({ role: "assistant", content: text });
      resp.historyIndex = answerIndex;
      resp.generationDone = true;
      this.log(`🤖 ${text}`);
      // `assistant_done` carries the checkpoint: the page stamps it on the bubble it just
      // finished, and that is what ⟲ on that bubble will point at
      this.emit({ type: "assistant_done", text, id: this.ids.get(this.history[answerIndex]!) });
    } finally {
      if (this.sentences === sentences) this.sentences = null;
      ttsCtl.abort();
      await ttsDone; // never rejects (the handler above ate it): just wait for the worker
    }
  }

  /**
   * The turn-taking judge, asked a different question: of the tools this round proposes,
   * which ones does the user's latest message actually ask for?
   *
   * Measured on Qwen3.5-4B-MTP (the default model): with the tools on offer, ANY vague
   * follow-up ("prova", "ok, grazie") makes the model re-run the previous turn's tool —
   * get_datetime after an interrupted (or even completed) date answer, run_command after
   * a story — 10/10 samples, and no wording of the system prompt (rules, few-shot
   * examples) stopped it. The judge, given only the proposed tools + the last assistant
   * line + the user's words, discriminates reliably ("Prova" → NONE, "che ore sono?" →
   * the clock), and a denied call gets the `gated.tool` line as its result, so the model
   * answers with a spoken sentence instead.
   *
   * Two things the judge needs beyond the tool name: the *arguments* (the user's words
   * are speech recognition — "web surfics" has to be matchable to
   * `{"name":"websurfx"}`, or the gate denies exactly the call that was meant) and the
   * active skill names. A call denied once is allowed if the model proposes it again
   * anyway: the judge is deterministic and would deny the identical call for all
   * TOOL_ROUNDS. A tool it already allowed for this turn is not asked about again
   * (`Response.gateAllowed`) and it is shown what this answer is already doing (`doing`),
   * so a follow-up of the same request — list → open one of the listed items — is
   * recognisable as part of it instead of as the model's own initiative.
   *
   * Two tools are never asked about at all (`GATE_EXEMPT_TOOLS`): `read_skill` /
   * `list_skills` only load context, they act on nothing, and the call that uses them
   * (`run_command`) is gated all the same. The judge is a small model shown a content
   * request ("quali sono le ultime notizie …") with the skill mention at the end
   * ("… Usa la skill.") and answers NONE — the read runs, the turn dies anyway, and the
   * same chain runs one user confirmation later (data/chat.json 372-381). A denial of a
   * read costs a round-trip and buys nothing.
   *
   * `null` = no gate: turned off (TOOL_GATE=0), the pi leg (pi executes its own tools),
   * or the judge failed — every call proceeds exactly as before.
   */
  private async gateTools(
    calls: ToolCall[],
    resp: Response,
    doing: string[] = [],
  ): Promise<Set<number> | null> {
    if (!this.cfg.toolGate || !this.cfg.llmEnableTools || this.cfg.llmViaPi) return null;
    // A tool the judge already allowed for this user message stays allowed for the rest of
    // the turn: the request's own follow-ups use it with *different* arguments ("leggi la
    // numero 5" after the list, a second curl on the same page), and asking the judge again
    // about the same tool only burns a round — 1.3-8.4 s each, data/logs/harness.log 13:38:38 →
    // 13:44:28 — and loses the call for good when the model does not repeat it verbatim
    // (the answer that followed at 13:45:01 was invented without the data it asked for).
    const names = calls.map((c) => c.function.name);
    // exempt (read-only) and already-allowed tools alike: both are carried without a question
    const ok = (i: number) => resp.gateAllowed.has(names[i]!) || GATE_EXEMPT_TOOLS.has(names[i]!);
    const carried = calls.map((_, i) => (ok(i) ? i : -1));
    const ask = calls.map((_, i) => i).filter((i) => !ok(i));
    if (!ask.length) {
      const tag = names.every((n) => GATE_EXEMPT_TOOLS.has(n))
        ? "read-only, not judged"
        : "already allowed for this turn";
      this.log(`   🛡 tool gate: ${names.join(", ")} ≡ ${tag}`);
      return new Set(calls.map((_, i) => i));
    }
    const prev =
      resp.userIndex !== null && resp.userIndex > 0 ? this.history[resp.userIndex - 1] : null;
    const prevAssistant = prev?.role === "assistant" ? String(prev.content ?? "") : "";
    const proposed = calls.map((c) => ({
      name: c.function.name,
      description: toolDescription(c.function.name),
      // the judge must see *what* was proposed: the user's words are speech
      // recognition ("web surfics") and cannot be matched to a bare tool name
      args: argSummary(c.function.arguments),
    }));
    const skills = (this.skills?.activeSkills() ?? []).map((s) => s.name).join(", ");
    try {
      const t0 = now();
      // …and only the calls whose tool is new for this turn: the carried ones are already
      // the answer to "does this user message ask for that tool?" (`doing` is copied:
      // the caller may keep the array, and this turn is still adding to it)
      const sub = await this.llm.judgeTools(
        this.toolGatePrompt,
        prevAssistant,
        resp.userText,
        ask.map((i) => proposed[i]!),
        skills,
        doing.slice(),
      );
      const allowed = new Set<number>([
        ...carried.filter((i) => i >= 0),
        ...ask.filter((_, k) => sub.has(k)),
      ]);
      // The judge is deterministic (temperature 0, the same words every round): once it
      // has denied a call it denies the identical call forever, and a model that
      // retries anyway would burn all TOOL_ROUNDS on it (data/logs/harness.log 11:35:48:
      // six read_skill rounds → first token at 15.2 s, then an answer about an
      // unrelated topic). The gated result already told it not to repeat the call —
      // if it did, run it rather than stall the turn.
      const retry = allowGateRetries(
        allowed,
        proposed.map((p) => `${p.name} ${p.args ?? ""}`),
        resp.denied,
      );
      for (const i of allowed) resp.gateAllowed.add(names[i]!);
      const list = proposed
        .map((p, i) =>
          carried[i]! >= 0
            ? `${p.name}≡`
            : allowed.has(i)
              ? retry.has(i)
                ? `${p.name}↻`
                : p.name
              : `${p.name}✗`,
        )
        .join(", ");
      this.log(`   🛡 tool gate: ${list}  (${(now() - t0).toFixed(2)} s)`);
      return allowed;
    } catch (e) {
      this.log(`[tool-gate] ${String(e).slice(0, 160)} — tool calls proceed unfiltered`);
      return null;
    }
  }

  private async ttsWorker(
    q: AsyncQueue<string | null>,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      // withAbort: an abort while the queue is empty must end the worker — a bare
      // `q.get()` waits forever and the response task would never settle
      const s = await withAbort(q.get(), signal);
      if (s === null) return;
      this.player.beginSegment(s);
      try {
        for await (const pcm of abortableIter(this.tts.stream(s, signal), signal)) {
          this.player.enqueue(pcm);
        }
      } finally {
        this.player.endSegment();
      }
    }
  }

  onSegmentStart(tag: string): void {
    if (this.resp !== null && tag) {
      this.resp.spoken.push(tag);
      this.onFirstAudio();
      this.emit({ type: "assistant", text: tag });
      this.refreshState();
    }
  }

  private onFirstAudio(): void {
    const r = this.resp;
    if (r === null || r.audioStarted) return;
    r.audioStarted = true;
    const t = now();
    const lat = (t - r.tUserDone) * 1000;
    const ttft = ((r.tFirstToken ?? t) - r.tUserDone) * 1000;
    this.stats.push({
      voice_to_audio_ms: lat,
      voice_to_first_token_ms: ttft,
    });
    this.log(`   ⏱ last voice → first token ${ttft.toFixed(0)} ms → first audio ${lat.toFixed(0)} ms`);
    this.emit({
      type: "latency",
      first_token_ms: Math.round(ttft),
      first_audio_ms: Math.round(lat),
    });
  }

  private onIdle(): void {
    const r = this.resp;
    if (r !== null && r.generationDone && !this.player.paused) this.finishResponse(r);
  }

  finishResponse(resp: Response): void {
    if (this.resp === resp) {
      this.resp = null;
      this.refreshState();
    }
  }

  cancelResponse(interrupted: boolean, dropUser = false): void {
    const resp = this.resp;
    if (resp === null) return;
    this.resp = null;
    resp.controller.abort();
    this.player.flush();
    this.emit({ type: "assistant_cancel" });
    if (dropUser) {
      // the whole unfinished turn goes — its tool cards included. Its text lives on in
      // pendingPrefix, and nothing made by it may stay behind in the history.
      if (resp.userIndex !== null) {
        this.history.length = Math.min(resp.userIndex, this.history.length);
        this.persistChat();
        return;
      }
      const last = this.history[this.history.length - 1];
      if (last && last.role === "user") this.history.pop();
      this.persistChat();
      return;
    }
    this.dropOpenTools(); // aborted between a tool call and its result
    const spoken = resp.spoken.join(" ").trim();
    const note = interrupted ? " … " + t(this.cfg.locale, "hist.interrupted") : "";
    const content =
      (spoken + note).trim() || t(this.cfg.locale, "hist.interruptedQuiet");
    if (resp.historyIndex !== null && resp.historyIndex < this.history.length) {
      this.history[resp.historyIndex]!.content = content;
      this.persistChat();   // its text changed ("… [interrotto dall'utente]")
    } else {
      this.addMessage({ role: "assistant", content });   // …and persists it itself
    }
  }

  // ── announcer ──

  /**
   * Something worth saying out of a turn: a timer ringing, a watch reporting its value.
   *
   * `key` is the task it belongs to (`timer-1`, `watch-2`), and a newer line with the
   * same key *replaces* the one still waiting: the newest value is the only interesting
   * one, and the queue can never hold more than one line per task however long the
   * assistant has been speaking. Without this a value watch floods it — measured: three
   * identical "Check of Internet Check" lines, all delivered 20 s after the watch had
   * already been stopped (data/logs/harness.log 21:13:47 / 21:14:07), and a stale
   * "Controllo di tmp-check" spoken into an unrelated conversation 2.5 minutes later.
   */
  announce(text: string, key = ""): void {
    const queued = key ? this.announcements.find((a) => a.key === key) : null;
    if (queued) queued.text = text;      // same task: the waiting line is the newest value
    else this.announcements.push({ key, text });
  }

  /**
   * The task is gone (✕ on its chip, stop_watch, the ring it already announced): what it
   * had queued to say goes with it. Otherwise the user closes a watch and it keeps
   * reporting — the one thing "stop" must never do.
   */
  withdrawAnnouncements(key: string): void {
    for (let i = this.announcements.length - 1; i >= 0; i--)
      if (this.announcements[i]!.key === key) this.announcements.splice(i, 1);
  }

  spawnAnnouncer(): AbortController {
    return this.spawn(async (signal) => {
      for (;;) {
        await abortableSleep(300, signal);
        if (this.announcements.length && this.resp === null && this.utt === null) {
          const { text } = this.announcements.shift()!;
          this.log(`🔔 ${text}`);
          this.emit({ type: "event", text: `🔔 ${text}` });
          const controller = new AbortController();
          const resp: Response = {
            userText: "",
            tUserDone: now(),
            controller,
            task: null,
            spoken: [],
            fullText: "",
            audioStarted: true,
            generationDone: false,
            historyIndex: null,
            userIndex: null,
            tFirstToken: null,
            denied: new Map(),
            gateAllowed: new Set(),
          };
          this.resp = resp;
          const speak = (async () => {
            const q = new AsyncQueue<string | null>();
            q.push(text);
            q.push(null);
            await this.ttsWorker(q, controller.signal);
            if (controller.signal.aborted) return;   // 🧹 while it rang → not into the new chat
            const ringIndex = this.addMessage({ role: "assistant", content: text });
            resp.historyIndex = ringIndex;
            resp.generationDone = true;
            this.emit({
              type: "assistant_done",
              text,
              id: this.ids.get(this.history[ringIndex]!),
            });
          })();
          resp.task = speak;
          this.responseTaskDone(resp, speak);
        }
      }
    });
  }
}
