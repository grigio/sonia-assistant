/** Shared LLM-leg types: chat messages, streaming items, tool calls. */

import type { ToolPayload } from "./toolcards";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessage = {
  role: ChatRole;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

/** What `LLM.stream()` yields: one discriminated `{kind, …}` item per stream event. */
export type StreamItem =
  | { kind: "reasoning"; text: string } // thinking: goes to the UI, never to TTS/history
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ToolPayload }
  | { kind: "event"; note: string }
  | { kind: "tool_calls"; calls: ToolCall[] }
  /** Token usage of the request that just ended → the header context bar. */
  | { kind: "usage"; prompt: number; completion: number };

export type TurnVerdict = "listen" | "speak";
