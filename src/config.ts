/**
 * Runtime configuration — every knob can be overridden from the environment:
 * field name, upper-cased = env var name (`llmBaseUrl` → `LLM_BASE_URL`).
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Locale, normalizeLocale } from "./i18n";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** pi's model when PI_MODEL is not set: the default assistant model, served by the
 *  same llama-server — 2.7 GiB Q4_K_M with MTP speculative decoding. */
export const PI_DEFAULT_MODEL = "llamacpp/Qwen3.5-4B-MTP-Q4_K_M";

/** The values CMD_MODE/DECISION_MODE accept — the exact literals `tools.ts` and `turn.ts`
 *  pattern-match on. An unvalidated env value would silently skip the approval gate in
 *  `runCommand` (anything but exactly "off"/"ask" behaves as "auto" there), so unknown
 *  spellings must never pass through. */
export const CMD_MODES = ["off", "ask", "auto"] as const;
export type CmdMode = (typeof CMD_MODES)[number];
export const DECISION_MODES = ["off", "auto", "always"] as const;
export type DecisionMode = (typeof DECISION_MODES)[number];

/**
 * Normalise one mode value. Case-insensitive on purpose ("ASK", "Auto" are fine).
 *
 * An unknown spelling falls back to the mode the *user can see what it does*: `ask` for
 * CMD_MODE, where the first non-read-only command knocks on the screen — the safest of
 * the three, and the one where a typo stops hiding (the previous behaviour risked exactly
 * the silent widening a mistake wants: `CMD_MODE=Ask2` looked like "never run" and ran
 * like `auto`). With stderr telling the user, the fallback is visible either way.
 */
export function normalizeCmdMode(raw: string, log = console.warn): CmdMode {
  const v = raw.trim().toLowerCase();
  for (const m of CMD_MODES) if (v === m) return m;
  if ((raw ?? "").trim())
    log(`⚠ CMD_MODE=${raw} is not one of off|ask|auto — using "ask" (safest)`);
  return "ask";
}

/** The same for DECISION_MODE: no safety implication, the class default ("auto") wins. */
export function normalizeDecisionMode(raw: string, log = console.warn): DecisionMode {
  const v = raw.trim().toLowerCase();
  for (const m of DECISION_MODES) if (v === m) return m;
  if ((raw ?? "").trim())
    log(`⚠ DECISION_MODE=${raw} is not one of off|auto|always — using "auto"`);
  return "auto";
}

/** The Pocket TTS packs `models-download` knows (a custom TTS_VOICE_DIR needs none). */
export const TTS_LANGS = ["italian", "english", "german", "portuguese", "spanish"] as const;

type Default = string | number | boolean;

/** The spellings a boolean env var accepts — anything else is a typo, not a value. */
const BOOL_TRUE = new Set(["1", "true", "yes", "on"]);
const BOOL_FALSE = new Set(["0", "false", "no", "off"]);

/**
 * Read one knob from the environment, coerced to the type of its default.
 *
 * Numbers throw on junk and enums warn (see `normalizeCmdMode`); booleans used to do
 * neither — `BARGE_IN=flase` silently became `false`, flipping a behaviour the user
 * thought they had set. Unknown spellings now warn and fall back to the field's own
 * **default** (the value its author chose), so a typo is visible and never quietly
 * disables something.
 */
export function env(
  name: string,
  def: Default,
  log: (msg: string) => void = console.warn,
): Default {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const trimmed = raw.trim();
  if (typeof def === "boolean") {
    const v = trimmed.toLowerCase();
    if (BOOL_TRUE.has(v)) return true;
    if (BOOL_FALSE.has(v)) return false;
    log(
      `⚠ ${name}=${raw} is not a boolean (1/true/yes/on | 0/false/no/off) — using the default ${def}`,
    );
    return def;
  }
  if (typeof def === "number") {
    if (Number.isNaN(Number(trimmed))) throw new Error(`env ${name}: not a number: ${raw}`);
    return Number.isInteger(def) ? Math.trunc(Number(trimmed)) : Number(trimmed);
  }
  return raw;
}

export class Config {
  // ── LLM leg: external OpenAI-compatible endpoint (an already-running llama-server) ──
  llmBaseUrl = "http://127.0.0.1:8080/v1";
  llmApiKey = "";
  llmModel = "Qwen3.5-4B-MTP-Q4_K_M";
  llmMaxTokens = 400;
  llmTemperature = 0.7;
  llmEnableTools = true;
  /** Master switch (the "ragionamento" checkbox): with thinking off — the default, since
   *  this model needs tens of seconds of reasoning per answer — there is nothing to show. */
  llmDisableThinking = true;
  /** Token headroom added to LLM_MAX_TOKENS while thinking is on: reasoning and answer
   *  share one budget, so the plain 400-token cap would be eaten by the thinking alone. */
  llmReasoningBudget = 1536;
  /** n_ctx of the LLM, for the header's context bar. 0 = read it from the model list
   *  (`/v1/models`, `pi --list-models`); set it when neither endpoint reports one. */
  llmContextWindow = 0;

  // ── LLM leg alternative: the `pi` CLI (checkbox "pi CLI" in the UI) ──
  llmViaPi = false;
  piCmd = "pi -c";
  piModel = PI_DEFAULT_MODEL;
  /** pi's `--thinking` level while thinking is on (LLM_DISABLE_THINKING=1 forces "off"). */
  piThinking = "medium";
  piCwd = path.join(ROOT, "data", "pi");
  piTimeoutS = 300;

  // ── local shell commands (run_command tool) ──
  cmdMode: "off" | "ask" | "auto" = "auto";
  cmdTimeoutS = 30;
  cmdApprovalTimeoutS = 60;

  // ── audio.cpp servers (ASR / TTS / Smart Turn) ──
  asrUrl = "http://127.0.0.1:8091";
  asrModel = "voxtral";
  asrLanguage = "";
  asrFlushPadMs = 640;
  ttsUrl = "http://127.0.0.1:8092";
  ttsModel = "pocket-it";
  /** Which Pocket TTS language pack (`TTS_LANG`): `english` | `german` | `italian` |
   *  `portuguese` | `spanish`. It picks the GGUF under `<MODELS_DIR>/PocketTTS-GGUF/<lang>/`
   *  that `bun run models-download` fetches, the voices of `ttsVoicesDir`, and the
   *  `language` load option audio.cpp's TTS server is started with. */
  ttsLang = "italian";
  ttsVoice = "eponine";
  /** Voice presets of the TTS pack (`<dir>/<voice>.safetensors`) — the list behind the
   *  voice selector in the settings drawer. Empty → the Italian pack under MODELS_DIR. */
  ttsVoiceDir = "";
  turnUrl = "http://127.0.0.1:8093";
  turnModel = "smart-turn";
  /** How often those servers are re-checked, in ms (`src/health.ts`): a dead ASR, TTS or
   *  LLM leg puts the header orb on `offline` and logs which one went away, a dead Smart
   *  Turn is only logged (turn-taking then falls back to the silence gap). The mic source
   *  is not polled — it signals the same `offline` on its own (`Assistant.setMicDown`).
   *  `0` turns the poller off. */
  healthPollMs = 10_000;

  // ── audio devices (PipeWire) ──
  micTarget = "";
  spkTarget = "";
  playbackLatencyMs = 60;

  // ── VAD (Silero) ──
  vadModel = path.join(ROOT, "models", "silero", "silero_vad.onnx");
  vadStartThreshold = 0.5;
  vadEndThreshold = 0.35;
  vadMinSpeechMs = 96;
  prerollMs = 480;

  // ── turn-taking (route R2: VAD + Smart Turn + silence gap + prompt decision) ──
  turnCheckMs = 200;
  minSilenceMs = 300;
  silenceMs = 900;
  maxSilenceMs = 2500;
  smartTurnThreshold = 0.5;
  decisionMode: "off" | "auto" | "always" = "auto";
  /** Optional *dedicated* endpoint for the 4-token LISTEN/REPLY judge (a second,
   *  smaller llama-server, so a pause never queues behind a streaming answer).
   *  Empty → the judge shares LLM_BASE_URL, exactly as before. */
  decisionBaseUrl = "";
  /** Model the judge runs on. Empty → LLM_MODEL. */
  decisionModel = "";
  /** Tool gate: the judge re-checks, once per round of tool calls, which of the proposed
   *  tools the user's latest message actually asks for. A small model offered tools
   *  re-runs the previous turn's tool for any vague follow-up ("prova" after an
   *  interrupted answer → get_datetime), and no wording of the system prompt stops it.
   *  Judge failures let every call through (never block an action on a hiccup).
   *  The read-only skill tools (`read_skill`, `list_skills`) are never judged: they load
   *  context and act on nothing, while the `run_command` using them is gated as usual. */
  toolGate = true;

  // ── barge-in / echo handling ──
  bargeIn = true;
  bargeVadThreshold = 0.7;
  bargeMinMs = 250;
  bargeConfirmWords = 3;
  echoOverlap = 0.6;
  halfDuplex = false;

  // ── skills (SKILL.md packages; the user activates them in the UI, they reach the
  //    context only through the prompt addendum + the list_skills / read_skill tools) ──
  /** pi's own folder by default, so one skill set serves both legs. `~` is expanded. */
  skillsDir = path.join(os.homedir(), ".pi", "agent", "skills");

  // ── misc ──
  /** UI language (`LOCALE`): `it` or `en`. It drives every user-visible string — the
   *  page, the event lines, the spoken sentences, a tool's result (the card shows it).
   *  Written as a POSIX locale (`it_IT.UTF-8`) the base language wins; anything unknown
   *  falls back to English. `it` is the default, the language the app was written in. */
  locale: Locale = "it";
  /** Keep the conversation across restarts: the transcript, the model's history and the
   *  ⟲ checkpoint ids are written to `<DATA_DIR>/chat.json` (0 = always start empty). */
  chatPersist = true;
  systemPromptFile = path.join(ROOT, "prompts", "system.txt");
  decisionPromptFile = path.join(ROOT, "prompts", "decision.txt");
  toolGatePromptFile = path.join(ROOT, "prompts", "tool-gate.txt");
  dataDir = path.join(ROOT, "data");
  debug = false;

  /** Models live in this repo (a real copy, never a symlink). */
  modelsDir = path.join(ROOT, "models");

  /** Where the selectable voices live (a dir of `<voice>.safetensors` files).
   *  A getter, so MODELS_DIR stays the single source of truth for the default — and
   *  TTS_LANG, since every pack ships its own `embeddings/` (same 26 voice ids). */
  get ttsVoicesDir(): string {
    return (
      this.ttsVoiceDir || path.join(this.modelsDir, "PocketTTS-GGUF", this.ttsLang, "embeddings")
    );
  }

  static fromEnv(log: (msg: string) => void = console.warn): Config {
    const cfg = new Config();
    const defaults: Record<string, Default> = {};
    for (const [key, value] of Object.entries(cfg)) defaults[key] = value as Default;
    for (const [key, def] of Object.entries(defaults)) {
      const name = key.replace(/([A-Z])/g, "_$1").toUpperCase(); // llmBaseUrl → LLM_BASE_URL
      const val = env(name, def, log);
      if (typeof def === "boolean") {
        (cfg as unknown as Record<string, Default>)[key] = val as boolean;
      } else if (typeof def === "number") {
        (cfg as unknown as Record<string, Default>)[key] = val as number;
      } else {
        (cfg as unknown as Record<string, Default>)[key] = String(val);
      }
    }
    // The enum modes get the one check their consumers cannot afford to miss: every
    // non-literal value acts as "auto" in `runCommand`'s `===` dispatch (and as "always
    // ask the judge" in the turn rules), so this is the only place the typo can be caught.
    cfg.cmdMode = normalizeCmdMode(cfg.cmdMode, log);
    cfg.decisionMode = normalizeDecisionMode(cfg.decisionMode, log);
    // A typo'd pack name silently serves no GGUF (the audio server starts with an
    // unknown `language`, the voices dir resolves to nothing). Named packs only; a
    // custom TTS_VOICE_DIR may want whatever it wants.
    if (!TTS_LANGS.includes(cfg.ttsLang as (typeof TTS_LANGS)[number])) {
      log(
        `⚠ TTS_LANG=${cfg.ttsLang} is none of ${TTS_LANGS.join("|")} — ` +
          `set TTS_VOICE_DIR if the pack under <MODELS_DIR>/PocketTTS-GGUF/custom/ is yours`,
      );
    }
    // PI_MODEL is also pi's *own* ambient variable: a bare "name" next to PI_PROVIDER must
    // not hijack ours (ours is always the full "provider/id").
    if (cfg.piModel && !cfg.piModel.includes("/")) cfg.piModel = PI_DEFAULT_MODEL;
    // LOCALE may be `it_IT.UTF-8` and may be junk: `locale` is one of ours either way
    cfg.locale = normalizeLocale(cfg.locale);
    return cfg;
  }
}
