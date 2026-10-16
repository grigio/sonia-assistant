/** Collapsible tool-card payloads shared by the API leg and the pi leg. */

import type { ToolEvent } from "../events";
import { type Locale, t } from "../i18n";

export type ToolPayload = Omit<ToolEvent, "type">;

/** One readable line for a tool call's arguments (the card's header). */
export function toolSummary(args: unknown): string {
  const a0 = args;
  let a: unknown = a0;
  if (typeof a === "string") {
    const raw = a;
    try {
      a = JSON.parse(raw);
    } catch {
      return raw.slice(0, 100);
    }
  }
  if (a !== null && typeof a === "object" && !Array.isArray(a)) {
    const obj = a as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return "";
    for (const key of ["command", "path", "file_path", "pattern", "query", "url", "text"]) {
      if (key in obj) return String(obj[key]).slice(0, 100);
    }
    return JSON.stringify(obj).slice(0, 100);
  }
  return String(a).slice(0, 100);
}

export function toolStart(
  origin: string,
  callId: string,
  name: string,
  args: unknown,
): ToolPayload {
  return {
    phase: "start",
    origin,
    id: callId,
    tool: name,
    summary: toolSummary(args),
    args,
  };
}

export function toolEnd(
  origin: string,
  callId: string,
  name: string,
  result: string,
  info = "",
  error = false,
  /** the tool gate refused it: the card says so (⛔) instead of claiming "✅ ok" */
  blocked = false,
): ToolPayload {
  return {
    phase: "end",
    origin,
    id: callId,
    tool: name,
    result,
    info,
    error: Boolean(error),
    ...(blocked ? { blocked: true } : {}),
  };
}

/** Readable text of a pi tool result (a dict of content blocks, not a str). */
export function piResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result !== null && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    const blocks = obj.content;
    if (Array.isArray(blocks)) {
      const text = blocks
        .filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
        .map((b) => String(b.text ?? "").trim())
        .filter(Boolean)
        .join(" ")
        .trim();
      if (text) return text;
    }
    for (const key of ["text", "error", "message"]) {
      if (obj[key]) return String(obj[key]);
    }
  }
  return String(result);
}

/** "exit 0 · 1.24 s" — the bits pi puts in structuredContent (shell tools). */
export function piToolInfo(result: unknown, locale: Locale = "it"): string {
  const sc =
    result !== null && typeof result === "object"
      ? ((result as Record<string, unknown>).structuredContent as
          | Record<string, unknown>
          | undefined)
      : undefined;
  if (!sc || typeof sc !== "object") return "";
  const bits: string[] = [];
  if (sc.exit_code !== null && sc.exit_code !== undefined) bits.push(`exit ${sc.exit_code}`);
  const wall = sc.wall_time_seconds;
  if (typeof wall === "number" && wall > 0) bits.push(`${wall.toFixed(2)} s`);
  if (sc.truncated) bits.push(t(locale, "tool.truncated"));
  return bits.join(" · ");
}
