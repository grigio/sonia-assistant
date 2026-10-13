/**
 * `data/chat.json` — the conversation as it stands, so that restarting the harness does
 * not empty the chat: the transcript the page draws, the model's own history, and the
 * ⟲ checkpoint id on every line (all three are rebuilt from this one file).
 *
 * The ids live in a `WeakMap` on the Assistant and must never reach the model nor
 * `--stats` (see `Assistant.stamp`), so here they are stored as an explicit `id` next to
 * each message and handed back to the same map on load.
 *
 * Two guarantees the loader gives the caller:
 *
 *  - **a whole file or nothing**: written tmp + `rename`, so a crash mid-write leaves the
 *    previous chat on disk instead of a torn JSON;
 *  - **a history the chat template accepts**: an `assistant` message whose tool calls
 *    were never answered (the process died mid-exchange) loses the call, a `tool` result
 *    with no call to answer loses the result, so the restored history can go straight
 *    into a request.
 *
 * Anything unreadable (no file yet, an older shape, hand-edited garbage) is `null`: an
 * empty chat is a fine default, a startup crash is not.
 */

import fs from "node:fs";
import path from "node:path";
import type { ChatMessage, ToolCall } from "../clients/llm";

/** One history message with the checkpoint id it had (what ⟲ on that line points at). */
export type StoredEntry = { id: number; msg: ChatMessage };

export type RestoredChat = { entries: StoredEntry[]; maxId: number };

/** Bumped when the layout changes; an unknown version is ignored, never guessed at. */
const VERSION = 1;

const ROLES = new Set(["system", "user", "assistant", "tool"]);

function isToolCall(v: unknown): v is ToolCall {
  const c = v as ToolCall | null;
  return (
    typeof c === "object" &&
    c !== null &&
    typeof c["id"] === "string" &&
    typeof (c["function"] as { name?: unknown } | undefined)?.name === "string"
  );
}

/** Keep a message only if it is something a request may carry. */
function validMessage(raw: unknown): ChatMessage | null {
  const m = raw as Partial<ChatMessage> | null;
  if (typeof m !== "object" || m === null) return null;
  if (typeof m.role !== "string" || !ROLES.has(m.role)) return null;
  if (m.content !== undefined && m.content !== null && typeof m.content !== "string") return null;
  const out: ChatMessage = { role: m.role as ChatMessage["role"] };
  if (m.content !== undefined) out.content = m.content;
  if (typeof m.tool_call_id === "string") out.tool_call_id = m.tool_call_id;
  if (Array.isArray(m.tool_calls) && m.tool_calls.every(isToolCall)) out.tool_calls = m.tool_calls;
  // a `tool` result of a call we could not restore would be an orphan: it goes with it
  if (out.role === "tool" && !out.tool_call_id) return null;
  return out;
}

/**
 * Drop what lost its other half: a `tool` result whose call is not in front of it (its
 * `tool_calls` message was dropped as invalid above). A trailing `assistant` message
 * whose calls are still unanswered is left to `Assistant.dropOpenTools()`, which knows
 * the live rules (and runs on every load anyway).
 */
export function pruneOrphans(msgs: ChatMessage[]): ChatMessage[] {
  const outstanding = new Set<string>();
  const out: ChatMessage[] = [];
  for (const m of msgs) {
    if (m.role === "tool") {
      const id = m.tool_call_id ?? "";
      if (!outstanding.delete(id)) continue; // nothing asked for it → it is not an answer
      out.push(m);
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const c of m.tool_calls) outstanding.add(c.id);
      out.push(m);
      continue;
    }
    out.push(m);
  }
  return out;
}

export class ChatStore {
  constructor(readonly file: string) {}

  /**
   * Write the history with its ids. `ids` is the Assistant's WeakMap: a message that is
   * no longer in the history simply has none, and never lands here (this is called only
   * with the live history).
   */
  save(history: ChatMessage[], ids: WeakMap<ChatMessage, number>): void {
    const entries: StoredEntry[] = [];
    for (const msg of history) {
      const id = ids.get(msg);
      if (id === undefined) continue; // unstamped = not checkpoint material
      entries.push({ id, msg });
    }
    const json = JSON.stringify({ v: VERSION, entries });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, this.file);
  }

  /** The stored chat, or `null` when there is nothing usable to restore. */
  load(): RestoredChat | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf-8");
    } catch {
      return null; // no file yet — the normal first run
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return null; // torn or hand-edited: an empty chat beats a startup crash
    }
    const obj = data as { v?: unknown; entries?: unknown } | null;
    if (typeof obj !== "object" || obj === null || obj.v !== VERSION) return null;
    if (!Array.isArray(obj.entries)) return null;

    const entries: StoredEntry[] = [];
    let maxId = 0;
    for (const raw2 of obj.entries) {
      const e = raw2 as { id?: unknown; msg?: unknown } | null;
      if (typeof e !== "object" || e === null) continue;
      if (typeof e.id !== "number" || !Number.isFinite(e.id) || e.id < 1) continue;
      const msg = validMessage(e.msg);
      if (!msg) continue;
      entries.push({ id: Math.trunc(e.id), msg });
      maxId = Math.max(maxId, Math.trunc(e.id));
    }
    if (!entries.length) return null;
    const restored = pruneOrphans(entries.map((e) => e.msg));
    if (!restored.length) return null;
    // keep the id of every message that survived, in order
    const byMsg = new Map<ChatMessage, number>(entries.map((e) => [e.msg, e.id]));
    return {
      entries: restored.map((msg) => ({ id: byMsg.get(msg) ?? 0, msg })),
      maxId,
    };
  }
}
