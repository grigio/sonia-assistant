/**
 * The wire protocol, shared with the harness: this client imports the very types
 * `src/web.ts` types the `/ws` socket with — no duplicated shapes, no drift between the
 * web UI and the GTK UI. Everything here is type-only: erased at runtime, so the client
 * stays runnable on its own.
 */
export type {
  ServerEvent,
  ClientCommand,
  HistoryMessage,
  TaskInfo,
  SkillInfo,
  StateName,
  HelloConfig,
} from "../src/events";

/**
 * Chat-content events that must not rebuild the log while a `reset` waits for its
 * `chat_reset` ack (the web UI's own list, see `static/index.html`).
 */
export const STALE_ON_RESET = [
  "user",
  "assistant",
  "assistant_done",
  "assistant_cancel",
  "partial",
  "latency",
  "event",
  "tool",
  "reasoning",
  "command_request",
  "command_resolved",
  "command_start",
  "command_result",
] as const;
