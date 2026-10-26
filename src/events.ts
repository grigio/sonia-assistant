/**
 * The `/ws` JSON protocol, typed.
 *
 * Two directions:
 *  - ServerEvent  : harness → browser (text frames; audio is binary frames)
 *  - ClientCommand: browser → harness (text frames)
 *
 * Derived from every `emit()` / `_send_json()` call in `src/harness/`, `src/web.ts`,
 * `src/tools.ts` and the `switch (ev.type)` in `static/index.html` (the UI that consumes
 * them) — keep both sides in sync: a `ServerEvent.type` without its `case` is silently
 * dropped by the UI.
 */

// ── shared shapes ──────────────────────────────────────────────────────────

export type StateName =
  | "listening"
  | "user"
  | "thinking"
  | "speaking"
  | "confirm"
  | "paused"
  | "offline";

/**
 * One line of the transcript as the `hello` (and every `chat_rewound`) hands it over.
 *
 * `id` is the **checkpoint** the ⟲ button on that line points at: a handle the page can
 * send back (`{type:"rewind", id}`) to say "cut the conversation here". It is minted per
 * history message by the harness and is *not* the message's index — indexes shift under
 * the page's feet (`fitHistory` drops the oldest turn), an id never does. Tool calls and
 * their results are never in this list: a `tool_calls` payload must not leak into the
 * transcript.
 */
export type HistoryMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** Checkpoint handle (`Assistant.rewindTo`); absent when the harness has none to give. */
  id?: number;
};

/** A skill as the UI renders it (checkbox list in the settings drawer). */
export type SkillInfo = { name: string; description: string; active: boolean };

/**
 * The banner above the chat: a timer still to ring, a command still running, a watch
 * still checking — the things the harness started and the user may want to stop.
 *
 * `due_in_ms` is *relative to the moment the frame is received*, never an absolute
 * timestamp: the browser then counts it down on its own clock, so a page whose clock
 * differs from the server's still shows the right number (and a reload re-sends it).
 */
export type TaskInfo = {
  /** Unique while it lives (`timer-1`, `cmd-3`): what a `task_cancel` refers to. */
  id: string;
  kind: "timer" | "command" | "watch";
  /** What the chip says: the timer's label, the command line itself, the watch's name. */
  label: string;
  /** ms until it ends by itself (rings / hits the command timeout / checks again); none =
   *  no deadline. A watch counts down to its NEXT check, so its chip is never stuck. */
  due_in_ms?: number;
};

export type HelloConfig = {
  half_duplex: boolean;
  barge_in: boolean;
  decision_mode: "off" | "auto" | "always";
  cmd_mode: "off" | "ask" | "auto";
  llm_via_pi: boolean;
  thinking: boolean;
};

// ── server → browser ───────────────────────────────────────────────────────

/**
 * Every `ServerEvent.type`, in one runtime list. The union below is the source of truth
 * for types; this constant is for the test that checks *both* front-ends (`static/index.html`
 * and `sonia-gtk4/app.ts`) have a `case` for each one — an event nobody renders is a
 * silent regression, and a `case` for an event nobody sends is dead code.
 */
export const SERVER_EVENT_TYPES = [
  "hello",
  "state",
  "partial",
  "user",
  "reasoning",
  "assistant",
  "assistant_done",
  "assistant_cancel",
  "latency",
  "context",
  "flush",
  "chat_reset",
  "session_taken",
  "chat_rewound",
  "event",
  "tasks",
  "tool",
  "command_request",
  "command_resolved",
  "command_start",
  "command_result",
  "models",
  "voices",
  "skills",
  "model_loading",
  "model_ready",
  "model_error",
] as const;

export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];

export type ServerEvent =
  | {
      type: "hello";
      rate: number;
      model: string;
      voice: string;
      /** The voices the TTS pack ships — the settings drawer's selector. */
      voices: string[];
      state: StateName;
      history: HistoryMessage[];
      models: string[];
      config: HelloConfig;
      /** Context meter (tokens used / n_ctx) so the header bar is right from the first frame. */
      context: { used: number; total: number };
      pending_command: { id: number; command: string } | null;
      /** The banner over the chat, as it stands when this page connects. */
      tasks: TaskInfo[];
      /** Skills found in SKILLS_DIR, with the user's active/inactive choice. */
      skills_dir: string;
      skills: SkillInfo[];
    }
  | { type: "state"; state: StateName }
  | { type: "partial"; text: string }
  /** `id` = the checkpoint of the history line this text became (none if it never did,
   *  e.g. an answer given to a pending command approval). */
  | { type: "user"; text: string; info?: string; id?: number }
  | { type: "reasoning"; text: string } // 💭 thinking delta → collapsed block in the UI
  | { type: "assistant"; text: string }
  /** The line is in the history now: `id` is its checkpoint (what ⟲ on it points at). */
  | { type: "assistant_done"; text: string; id?: number }
  | { type: "assistant_cancel" }
  | { type: "latency"; first_token_ms: number; first_audio_ms: number }
  | { type: "context"; used: number; total: number } // context bar: tokens used / n_ctx
  | { type: "flush" }
  | { type: "chat_reset" } // 🧹 ack: everything sent before this belongs to the erased chat
  /**
   * Another window opened the app and took the single client slot: this page is now a
   * spectator — the server is about to close it, it must stop reconnecting (or the two
   * windows would kick each other every 1.5 s forever) and say so instead of leaving a
   * text box that quietly goes nowhere.
   */
  | { type: "session_taken" }
  /**
   * ⟲ ack for `{type:"rewind"}`: `ok=false` = that checkpoint is not in the history
   * (stale page, or the turn was trimmed away) and nothing was touched. `history` is the
   * transcript as the server really kept it — the page cuts its own DOM from the first
   * line missing from it, so the two stay in step whatever had been rendered.
   */
  | { type: "chat_rewound"; ok: boolean; history: HistoryMessage[] }
  | { type: "event"; text: string }
  | { type: "tasks"; tasks: TaskInfo[] } // the banner: sent whole, on every change
  | ToolEvent
  | { type: "command_request"; id: number; command: string; reason?: string }
  | { type: "command_resolved"; id: number }
  | { type: "command_start"; id: number; command: string; auto: boolean }
  | { type: "command_result"; id: number; command: string; status: string; output: string }
  | { type: "models"; models: string[]; current: string; via_pi?: boolean }
  | { type: "voices"; voices: string[]; current: string; rate?: number } // voice selector
  | { type: "skills"; dir: string; skills: SkillInfo[] } // rescan / after a toggle
  | { type: "model_loading"; model: string }
  | { type: "model_ready"; model: string; seconds: number }
  | { type: "model_error"; model: string; current: string; error: string };

/** A tool call (harness' own or pi's) rendered as a collapsible card. */
export type ToolEvent = {
  type: "tool";
  phase: "start" | "end";
  origin: "harness" | "pi" | string;
  id: string;
  tool: string;
  summary?: string;
  args?: unknown;
  result?: string;
  info?: string;
  error?: boolean;
  /** Refused by the tool gate (guardrail), never executed — not a success, not an error. */
  blocked?: boolean;
};

// ── browser → server ───────────────────────────────────────────────────────

export type ClientCommand =
  | { type: "text"; text: string }
  | { type: "reset" }
  /** ⟲ keep this history message and everything before it, drop the rest (`hello` ids). */
  | { type: "rewind"; id: number }
  | { type: "stop" }
  | { type: "approve"; id: number; ok: boolean }
  | { type: "model"; model: string }
  | { type: "models_refresh"; force?: boolean }
  | { type: "skills_refresh" } // rescan SKILLS_DIR (a skill may have been installed)
  | { type: "task_cancel"; id: string } // ✕ on one chip of the banner
  | { type: "skills_set"; active: string[] } // the checkbox list the user just picked
  | {
      type: "config";
      half_duplex?: boolean;
      barge_in?: boolean;
      decision_mode?: "off" | "auto" | "always";
      cmd_mode?: "off" | "ask" | "auto";
      llm_via_pi?: boolean;
      thinking?: boolean;
      /** TTS voice preset picked in the settings drawer. */
      tts_voice?: string;
    };
