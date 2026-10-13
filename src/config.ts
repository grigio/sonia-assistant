/**
 * Runtime configuration — every knob can be overridden from the environment:
 * field name, upper-cased = env var name (`llmBaseUrl` → `LLM_BASE_URL`).
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeLocale, type Locale } from "./i18n";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** pi's model when PI_MODEL is not set: the default assistant model, served by the
 *  same llama-server — 2.7 GiB Q4_K_M with MTP speculative decoding. */
export const PI_DEFAULT_MODEL = "llamacpp/Qwen3.5-4B-MTP-Q4_K_M";

type Default = string | number | boolean;

function env(name: string, def: Default): Default {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const trimmed = raw.trim();
  if (typeof def === "boolean") return ["1", "true", "yes", "on"].includes(trimmed.toLowerCase());
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
  /** How often those three servers are re-checked, in ms (`src/health.ts`): a dead
   *  ASR/TTS puts the header orb on `offline`, a dead Smart Turn is only logged.
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
   *  Judge failures let every call through (never block an action on a hiccup). */
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

  static fromEnv(): Config {
    const cfg = new Config();
    const defaults: Record<string, Default> = {};
    for (const [key, value] of Object.entries(cfg)) defaults[key] = value as Default;
    for (const [key, def] of Object.entries(defaults)) {
      const name = key.replace(/([A-Z])/g, "_$1").toUpperCase(); // llmBaseUrl → LLM_BASE_URL
      const val = env(name, def);
      if (typeof def === "boolean") {
        (cfg as unknown as Record<string, Default>)[key] = val as boolean;
      } else if (typeof def === "number") {
        (cfg as unknown as Record<string, Default>)[key] = val as number;
      } else {
        (cfg as unknown as Record<string, Default>)[key] = String(val);
      }
    }
    // PI_MODEL is also pi's *own* ambient variable: a bare "name" next to PI_PROVIDER must
    // not hijack ours (ours is always the full "provider/id").
    if (cfg.piModel && !cfg.piModel.includes("/")) cfg.piModel = PI_DEFAULT_MODEL;
    // LOCALE may be `it_IT.UTF-8` and may be junk: `locale` is one of ours either way
    cfg.locale = normalizeLocale(cfg.locale);
    return cfg;
  }
}

export type ConfigKey = keyof Config;
