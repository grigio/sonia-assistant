/**
 * `data/chat.json` — the conversation across a restart (P1-8):
 *
 *   - the store round-trips messages *with* their checkpoint ids, and writes atomically;
 *   - what cannot be restored is dropped rather than guessed at (torn file, old shape,
 *     a `tool` result whose call is gone);
 *   - through the `Assistant`: a second instance sees the same transcript with the same
 *     ids (⟲ works across a restart), keeps minting *new* ids after it, and 🧹 empties
 *     the file so the next start does not resurrect the chat.
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../../src/config";
import type { ChatMessage, StreamItem } from "../../src/clients/llm";
import { ChatStore, pruneOrphans } from "../../src/harness/chat-store";
import { Assistant } from "../../src/harness/assistant";
import { Tools } from "../../src/tools";

const dirs: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fd-chat-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const storeIn = (dir: string) => new ChatStore(path.join(dir, "chat.json"));

/** A stamped history: the ids the Assistant would have given it. */
function stamped(msgs: ChatMessage[]): { history: ChatMessage[]; ids: WeakMap<ChatMessage, number> } {
  const ids = new WeakMap<ChatMessage, number>();
  msgs.forEach((m, i) => ids.set(m, i + 1));
  return { history: msgs, ids };
}

describe("ChatStore", () => {
  test("round-trips the messages and their checkpoint ids", () => {
    const dir = tmp();
    const { history, ids } = stamped([
      { role: "user", content: "prima" },
      { role: "assistant", content: "uno" },
      { role: "user", content: "seconda" },
    ]);
    storeIn(dir).save(history, ids);

    const back = storeIn(dir).load();
    expect(back).not.toBeNull();
    expect(back!.entries.map((e) => e.msg.content)).toEqual(["prima", "uno", "seconda"]);
    expect(back!.entries.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(back!.maxId).toBe(3);
  });

  test("writes atomically: no .tmp file is left behind", () => {
    const dir = tmp();
    const { history, ids } = stamped([{ role: "user", content: "x" }]);
    storeIn(dir).save(history, ids);
    expect(fs.readdirSync(dir)).toEqual(["chat.json"]);
  });

  test("a message the Assistant never stamped has no checkpoint and is not stored", () => {
    const dir = tmp();
    const history: ChatMessage[] = [
      { role: "user", content: "keep me" },
      { role: "assistant", content: "unstamped" },
    ];
    const ids = new WeakMap<ChatMessage, number>();
    ids.set(history[0]!, 7);
    storeIn(dir).save(history, ids);
    const back = storeIn(dir).load();
    expect(back!.entries.map((e) => e.msg.content)).toEqual(["keep me"]);
    expect(back!.maxId).toBe(7);
  });

  test("no file, a torn file, an old shape: null, never a throw", () => {
    const dir = tmp();
    expect(storeIn(dir).load()).toBeNull();

    fs.writeFileSync(path.join(dir, "chat.json"), '{"v":1,"entries":[{"id":1,');
    expect(storeIn(dir).load()).toBeNull();

    fs.writeFileSync(path.join(dir, "chat.json"), JSON.stringify({ v: 99, entries: [] }));
    expect(storeIn(dir).load()).toBeNull();

    fs.writeFileSync(path.join(dir, "chat.json"), JSON.stringify({ v: 1, entries: "nope" }));
    expect(storeIn(dir).load()).toBeNull();

    fs.writeFileSync(path.join(dir, "chat.json"), JSON.stringify({ v: 1, entries: [{ id: 3, msg: { role: "nonsense", content: 42 } }] }));
    expect(storeIn(dir).load()).toBeNull();
  });

  test("a tool result whose call was lost goes with it", () => {
    const kept = pruneOrphans([
      { role: "user", content: "leggi" },
      { role: "tool", tool_call_id: "c1", content: "orphan" },   // no call in front of it
      { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "read_skill", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c9", content: "of another call" },
      { role: "tool", tool_call_id: "c2", content: "the real answer" },
      { role: "assistant", content: "ecco" },
    ]);
    expect(kept.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(kept[2]!.content).toBe("the real answer");
  });
});

// ── through the Assistant ─────────────────────────────────────────────────────

/** An `Assistant` wired to a scripted LLM/TTS/Player (no network, no audio, no mic). */
function scripted(cfg: Config): Assistant {
  const a = new Assistant(cfg, null, "null");
  a.log = () => {};
  a.tools = new Tools({ dataDir: cfg.dataDir, announce: () => {}, cmdMode: "off" });
  const stub = a as unknown as { llm: unknown; tts: unknown; player: unknown };
  stub.llm = {
    stream: async function* (): AsyncGenerator<StreamItem> {
      yield { kind: "text", text: "risposta" };
    },
    resetSession: () => {},
    rewindSession: () => {},
  };
  stub.tts = { stream: async function* (): AsyncGenerator<Uint8Array> {} };
  stub.player = {
    busy: false,
    paused: false,
    audible: false,
    flush: () => {},
    beginSegment: () => {},
    endSegment: () => {},
    enqueue: () => {},
  };
  return a;
}

async function turn(a: Assistant, text: string): Promise<void> {
  a.startResponse(text, Date.now());
  await a.resp?.task;
}

describe("the conversation survives a restart", () => {
  test("the same lines, the same ids — and new ids from then on", async () => {
    const dataDir = path.join(tmp(), "data");
    const mk = () => {
      const cfg = Config.fromEnv();
      cfg.dataDir = dataDir;
      cfg.chatPersist = true;
      return scripted(cfg);
    };

    const first = mk();
    first.restoreChat();                 // what start() does — and what arms the store
    expect(first.chatLines()).toEqual([]); // nothing to restore yet
    await turn(first, "prima");
    await turn(first, "seconda");
    const before = first.chatLines();
    expect(before.map((l) => l.content)).toEqual(["prima", "risposta", "seconda", "risposta"]);

    // a second process: same data dir, a fresh Assistant
    const second = mk();
    second.restoreChat();
    const restored = second.chatLines();
    expect(restored.map((l) => l.content)).toEqual(before.map((l) => l.content));
    expect(restored.map((l) => l.id)).toEqual(before.map((l) => l.id));
    expect(second.history).toHaveLength(first.history.length);

    // ids keep being unique after a restore (msgSeq continues where the file stopped)
    await turn(second, "terza");
    const ids = second.chatLines().map((l) => l.id!);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.max(...ids)).toBeGreaterThan(Math.max(...before.map((l) => l.id!)));
  });

  test("🧹 empties the file: the next start does not resurrect the chat", async () => {
    const dataDir = path.join(tmp(), "data");
    const mk = () => {
      const cfg = Config.fromEnv();
      cfg.dataDir = dataDir;
      cfg.chatPersist = true;
      return scripted(cfg);
    };
    const a = mk();
    a.restoreChat();
    await turn(a, "da cancellare");
    expect(a.chatLines()).toHaveLength(2);

    a.resetConversation();
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "chat.json"), "utf-8")).entries).toEqual([]);

    const b = mk();
    b.restoreChat();
    expect(b.chatLines()).toEqual([]);
  });

  test("CHAT_PERSIST=0 keeps the old behaviour: nothing written, nothing restored", async () => {
    const dataDir = path.join(tmp(), "data");
    const cfg = Config.fromEnv();
    cfg.dataDir = dataDir;
    cfg.chatPersist = false;
    const a = scripted(cfg);
    a.restoreChat();
    await turn(a, "non salvarmi");
    expect(fs.existsSync(path.join(dataDir, "chat.json"))).toBe(false);
    expect(scripted(cfg).chatLines()).toEqual([]);   // no restore either
  });
});
