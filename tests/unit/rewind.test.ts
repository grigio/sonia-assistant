/**
 * ⟲ rewind the conversation to a checkpoint (`Assistant.rewindTo`, `chatLines`).
 *
 * 🧹 erases the whole chat; this erases only the part the user is sorry about. What the
 * tests pin down:
 *
 *   - a checkpoint is a *per-message id*, never an index: what survived keeps its ids, so
 *     the page can ⟲ further back after having ⟲ once;
 *   - the target line and everything before it stay, everything after it goes — and the
 *     target itself is *never* dropped, not even an unanswered question of the user's
 *     (the next one is glued onto it on the wire, by `forModel`, not in the history);
 *   - a line whose own tool results the cut took keeps its text: the calls go, the line
 *     the button sits on does not;
 *   - the cut never leaves a tool call without its results;
 *   - an unknown/stale checkpoint changes *nothing* (no silent truncation to a wrong index);
 *   - ids are a WeakMap, so they never reach the model (`JSON.stringify(messages)`) nor
 *     `--stats`;
 *   - the in-flight turn is cancelled, and the epoch is bumped like 🧹 does, so a tool
 *     result or a command card still on its way from the dropped part lands nowhere.
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../../src/config";
import type { ChatMessage, StreamItem } from "../../src/clients/llm";
import { Assistant } from "../../src/harness/assistant";
import { Tools } from "../../src/tools";

type Plan = { text?: string };
const call = (id: string, name = "read_skill") => ({
  id,
  type: "function" as const,
  function: { name, arguments: '{"name":"demo"}' },
});

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** An `Assistant` wired to a scripted LLM / TTS / Player: no network, no audio, no mic. */
function scripted(plans: Plan[] = []): {
  a: Assistant;
  requests: ChatMessage[][];
  piRewinds: { n: number };
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-rewind-"));
  dirs.push(tmp);
  const cfg = Config.fromEnv();
  cfg.llmViaPi = false;
  cfg.locale = "it";
  const a = new Assistant(cfg, null, "null");
  a.log = () => {};
  a.tools = new Tools({
    dataDir: path.join(tmp, "data"),
    announce: () => {},
    cmdMode: "auto",
  });

  const requests: ChatMessage[][] = [];
  const piRewinds = { n: 0 };
  const stub = a as unknown as { llm: unknown; tts: unknown; player: unknown };
  stub.llm = {
    stream: async function* (messages: ChatMessage[]): AsyncGenerator<StreamItem> {
      requests.push(structuredClone(messages)); // exactly what would go on the wire
      const plan = plans.shift();
      if (plan?.text) yield { kind: "text", text: plan.text };
    },
    resetSession: () => {},
    rewindSession: () => {
      piRewinds.n++;
    },
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
  return { a, requests, piRewinds };
}

/** One turn: the answer comes from the plans `scripted()` was given, in order. */
async function turn(a: Assistant, text: string): Promise<void> {
  a.startResponse(text, Date.now());
  await a.resp?.task;
}

/** The checkpoint of the line whose content is exactly `content`. */
function cp(a: Assistant, content: string): number {
  const line = a.chatLines().find((m) => m.content === content);
  if (!line || line.id === undefined) throw new Error(`no checkpoint for «${content}»`);
  return line.id;
}

/** Three finished turns: prima/uno · seconda/due · terza/tre. */
async function threeTurns(a: Assistant): Promise<void> {
  await turn(a, "prima");
  await turn(a, "seconda");
  await turn(a, "terza");
}

describe("rewind to a checkpoint", () => {
  test("keeps the target and everything before it, drops the rest", async () => {
    const { a } = scripted([{ text: "uno" }, { text: "due" }, { text: "tre" }]);
    await threeTurns(a);
    const lines = a.chatLines();

    expect(lines.map((m) => m.content)).toEqual([
      "prima", "uno", "seconda", "due", "terza", "tre",
    ]);
    expect(new Set(lines.map((m) => m.id)).size).toBe(lines.length); // one id per line

    expect(a.rewindTo(lines[3]!.id!)).toBe(true); // ⟲ on «due»
    expect(a.history.map((m) => m.content)).toEqual(["prima", "uno", "seconda", "due"]);

    // …and the ids that survived are the same ones: the page can ⟲ further back now
    expect(a.chatLines().map((m) => m.id)).toEqual(lines.slice(0, 4).map((m) => m.id));
  });

  test("⟲ on your own unanswered question keeps it, and the next one is its own line", async () => {
    const { a, requests } = scripted([{ text: "uno" }, { text: "due" }, { text: "risposta" }]);
    await turn(a, "prima");
    await turn(a, "seconda");
    a.addMessage({ role: "user", content: "domanda rimasta in sospeso" });
    expect(a.history.at(-1)!.role).toBe("user");

    const q = cp(a, "domanda rimasta in sospeso");
    expect(a.rewindTo(q)).toBe(true);
    // the line the button sits on is the one thing a ⟲ never drops
    expect(a.history.map((m) => m.content)).toEqual([
      "prima", "uno", "seconda", "due", "domanda rimasta in sospeso",
    ]);

    // the next question gets a line — and a checkpoint — of its own, so a later ⟲ can cut
    // *between* the two; it is the request that glues them into one turn (Gemma wants
    // strict user/assistant alternation, and the transcript wants one id per line)
    await turn(a, "seconda domanda");
    expect(a.chatLines().map((m) => m.content)).toEqual([
      "prima", "uno", "seconda", "due", "domanda rimasta in sospeso", "seconda domanda", "risposta",
    ]);
    expect(new Set(a.chatLines().map((m) => m.id)).size).toBe(a.chatLines().length);
    expect(
      requests.at(-1)!.some(
        (m) => m.role === "user" && m.content === "domanda rimasta in sospeso seconda domanda",
      ),
    ).toBe(true); // …and never two user messages in a row on the wire

    // …and ⟲ on the older question now cuts the newer one away with its answer
    expect(a.rewindTo(q)).toBe(true);
    expect(a.history.map((m) => m.content)).toEqual([
      "prima", "uno", "seconda", "due", "domanda rimasta in sospeso",
    ]);
  });

  test("the cut never leaves a tool call without its results — nor the line they are on", async () => {
    const { a } = scripted([]);
    a.addMessage({ role: "user", content: "leggi la skill" });
    a.addMessage({ role: "assistant", content: "certo", tool_calls: [call("c1"), call("c2")] });
    a.addMessage({ role: "tool", tool_call_id: "c1", content: "corpo della skill" });
    a.addMessage({ role: "assistant", content: "fatto" });
    // the tool round's partial text *is* a line the page can ⟲ (it has string content)
    expect(a.chatLines().map((m) => m.content)).toEqual([
      "leggi la skill", "certo", "fatto",
    ]);

    expect(a.rewindTo(cp(a, "certo"))).toBe(true);
    expect(a.history.some((m) => m.tool_calls?.length)).toBe(false); // c2 was never answered
    expect(a.history.some((m) => m.role === "tool")).toBe(false);    // …nor c1's result
    // the calls go because their answers went with the cut — but the clicked line stays
    expect(a.history.map((m) => m.content)).toEqual(["leggi la skill", "certo"]);
    expect(a.chatLines().map((m) => m.content)).toEqual(["leggi la skill", "certo"]);
  });

  test("an unknown or already-dropped checkpoint changes nothing", async () => {
    const { a } = scripted([{ text: "uno" }, { text: "due" }]);
    await turn(a, "prima");
    await turn(a, "seconda");
    const before = structuredClone(a.history);

    expect(a.rewindTo(999_999)).toBe(false);
    expect(a.rewindTo(0)).toBe(false);            // ids start at 1 and are never reused
    expect(a.history).toEqual(before);            // not one message touched
    expect(a.chatLines()).toHaveLength(4);
  });

  test("the turn being answered is cancelled by the rewind", async () => {
    const { a } = scripted([{ text: "uno" }, { text: "due" }]);
    await turn(a, "prima");
    await turn(a, "seconda");
    const keep = cp(a, "due");
    const userIndex = a.addMessage({ role: "user", content: "sto rispondendo" });
    a.resp = {
      userText: "sto rispondendo",
      tUserDone: 0,
      controller: new AbortController(),
      task: null,
      spoken: ["mezza frase"],
      fullText: "",
      audioStarted: true,
      generationDone: false,
      historyIndex: null,
      userIndex,
      tFirstToken: null,
      denied: new Map(),
      gateAllowed: new Set(),
    };

    expect(a.rewindTo(keep)).toBe(true);
    expect(a.resp).toBeNull();                   // the half-turn is over, not paused
    expect(a.history.map((m) => m.content)).toEqual(["prima", "uno", "seconda", "due"]);
    expect(a.history.some((m) => m.content === "sto rispondendo")).toBe(false);
  });

  test("⟲ on the very line being answered keeps that line (the answer still goes)", async () => {
    const { a } = scripted([{ text: "uno" }, { text: "due" }]);
    await turn(a, "prima");
    await turn(a, "seconda");
    const userIndex = a.addMessage({ role: "user", content: "sto rispondendo" });
    a.resp = {
      userText: "sto rispondendo",
      tUserDone: 0,
      controller: new AbortController(),
      task: null,
      spoken: ["mezza frase"],
      fullText: "",
      audioStarted: true,
      generationDone: false,
      historyIndex: null,
      userIndex,
      tFirstToken: null,
      denied: new Map(),
      gateAllowed: new Set(),
    };

    expect(a.rewindTo(cp(a, "sto rispondendo"))).toBe(true);
    expect(a.resp).toBeNull();                   // the answer is over, the question is not
    // `cancelResponse` had already cut the in-flight turn off the end of the history:
    // the checkpoint's own cut is the one that counts, so the clicked line is put back
    expect(a.history.map((m) => m.content)).toEqual([
      "prima", "uno", "seconda", "due", "sto rispondendo",
    ]);
    expect(a.history.at(-1)!.role).toBe("user");  // kept, dangling and all
  });

  test("like 🧹, it bumps the epoch: late tool events belong to the dropped part", async () => {
    const { a } = scripted([{ text: "uno" }]);
    await turn(a, "prima");
    const epoch = () => (a as unknown as { epoch: number }).epoch;
    const before = epoch();
    expect(a.rewindTo(cp(a, "prima"))).toBe(true);
    expect(epoch()).toBe(before + 1);
  });

  test("in pi mode pi's own session is rebuilt from what survived", async () => {
    const { a, piRewinds } = scripted([{ text: "uno" }, { text: "due" }]);
    await turn(a, "prima");
    await turn(a, "seconda");
    a.cfg.llmViaPi = true;

    expect(a.rewindTo(cp(a, "uno"))).toBe(true);
    expect(piRewinds.n).toBe(1);                 // new conv, re-seeded with the kept turns
    expect(a.history.map((m) => m.content)).toEqual(["prima", "uno"]);
  });
});

describe("the transcript the page is given", () => {
  test("chatLines is the chat lines only — tool payloads never travel", async () => {
    const { a } = scripted([]);
    a.addMessage({ role: "user", content: "leggi" });
    a.addMessage({ role: "assistant", content: null, tool_calls: [call("c1")] });
    a.addMessage({ role: "tool", tool_call_id: "c1", content: "corpo della skill segreta" });
    a.addMessage({ role: "assistant", content: "fatto" });

    const lines = a.chatLines();
    expect(lines.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(lines)).not.toContain("skill segreta");
    expect(lines.every((m) => typeof m.id === "number")).toBe(true);
  });

  test("the ids are a WeakMap: they never reach the model nor the stats file", async () => {
    const { a, requests } = scripted([{ text: "uno" }]);
    await turn(a, "prima");
    expect(a.chatLines()[0]!.id).toBeGreaterThan(0);

    expect(JSON.stringify(a.history)).not.toContain('"id"');
    expect(JSON.stringify(requests.at(-1))).not.toContain('"id"');
  });
});
