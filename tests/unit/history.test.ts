/**
 * The tool exchange must survive the turn.
 *
 * `runResponse()` used to build its request from a *local* array, so a `read_skill` result
 * was thrown away the moment the turn ended: the next request started without the SKILL.md
 * and the model read the same skill over and over (data/logs/harness.log: virb + reddit read
 * once per turn, three turns in a row). These tests pin the fixed behaviour:
 *
 *   - the exchange lands in `history` and is still in the next request
 *   - `read_skill` hands out a body that is already in the context only once
 *   - 🧹 puts it back to "first read"
 *   - a turn cut mid-exchange leaves no call without its result
 *   - an over-long history loses its oldest turn, never the current one
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, StreamItem } from "../../src/clients/llm";
import { Config } from "../../src/config";
import { Assistant } from "../../src/harness/assistant";
import { Skills } from "../../src/skills";
import { Tools } from "../../src/tools";

type Plan = { calls?: { name: string; args: string }[]; text?: string };
const SKILL_MD = "---\nname: demo\ndescription: A demo skill.\n---\n# Demo\nrun scripts/x.ts\n";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * An `Assistant` wired to a scripted LLM / TTS / Player: no network, no audio, no mic.
 * One `Plan` per model call — `calls` makes it ask for a tool, `text` answers.
 */
function scripted(plans: Plan[]): { a: Assistant; requests: ChatMessage[][] } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-hist-"));
  dirs.push(tmp);
  const dir = path.join(tmp, "skills");
  fs.mkdirSync(path.join(dir, "demo"), { recursive: true });
  fs.writeFileSync(path.join(dir, "demo", "SKILL.md"), SKILL_MD);

  const cfg = Config.fromEnv();
  cfg.llmEnableTools = true;
  cfg.llmViaPi = false;
  cfg.locale = "it"; // this file pins Italian wording ("interrotto") — not the .env
  const a = new Assistant(cfg, null, "null");
  a.log = () => {};
  a.skills = new Skills({ dir, dataDir: path.join(tmp, "data") });
  a.tools = new Tools({
    dataDir: path.join(tmp, "data"),
    announce: () => {},
    cmdMode: "auto",
    skills: a.skills,
    history: () => a.history,
  });

  const requests: ChatMessage[][] = [];
  const stub = a as unknown as { llm: unknown; tts: unknown; player: unknown };
  stub.llm = {
    stream: async function* (messages: ChatMessage[]): AsyncGenerator<StreamItem> {
      requests.push(structuredClone(messages)); // exactly what would go on the wire
      const plan = plans.shift();
      if (plan?.calls?.length) {
        yield {
          kind: "tool_calls",
          calls: plan.calls.map((c, i) => ({
            id: `c${i + 1}`,
            type: "function",
            function: { name: c.name, arguments: c.args },
          })),
        };
      }
      if (plan?.text) yield { kind: "text", text: plan.text };
    },
    resetSession: () => {},
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
  return { a, requests };
}

/** One spoken turn, resolved when the response task is done. */
async function turn(a: Assistant, text: string): Promise<void> {
  a.startResponse(text, Date.now());
  await a.resp?.task;
}

const call = (id: string, name = "read_skill") => ({
  id,
  type: "function" as const,
  function: { name, arguments: '{"name":"demo"}' },
});

describe("a tool exchange lives in the history, not only in its own request", () => {
  test("a skill read in one turn is still in the context of the next", async () => {
    const { a, requests } = scripted([
      { calls: [{ name: "read_skill", args: '{"name":"demo"}' }] },
      { text: "Ho letto la skill." },
      { text: "Va bene." },
    ]);

    await turn(a, "leggi la skill demo");
    expect(a.history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(a.history[2]!.content).toContain("# Demo"); // the body is stored, not discarded

    await turn(a, "e adesso?");
    const second = requests.at(-1)!;
    expect(second.some((m) => m.role === "tool" && String(m.content).includes("# Demo"))).toBe(
      true,
    );
    expect(second.some((m) => m.content === "Ho letto la skill.")).toBe(true); // the turn before
    expect(second.at(-1)!.content).toBe("e adesso?");
  });

  test("read_skill does not hand out a body that is already in the context", async () => {
    const { a } = scripted([
      { calls: [{ name: "read_skill", args: '{"name":"demo"}' }] },
      { text: "Fatto." },
    ]);
    await turn(a, "leggi la skill");

    const again = await a.tools.call("read_skill", '{"name":"demo"}');
    expect(again).toContain("already in the messages above");
    expect(again).not.toContain("# Demo"); // no second copy through the context
  });

  test("🧹 empties the context → the skill can be read again", async () => {
    const { a } = scripted([
      { calls: [{ name: "read_skill", args: '{"name":"demo"}' }] },
      { text: "Fatto." },
    ]);
    await turn(a, "leggi la skill");
    expect(await a.tools.call("read_skill", '{"name":"demo"}')).toContain("already");

    a.resetConversation();
    expect(a.history).toHaveLength(0);
    const fresh = await a.tools.call("read_skill", '{"name":"demo"}');
    expect(fresh).toContain("# Demo"); // first read of this conversation again
  });
});

describe("a response cut mid-exchange", () => {
  const withResp = (a: Assistant, userIndex: number): void => {
    a.resp = {
      userText: "leggi",
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
      gateFailed: false,
      tainted: false,
    };
  };

  test("a call with no result would break the template → the exchange goes", () => {
    const { a } = scripted([]);
    a.history = [
      { role: "user", content: "leggi" },
      { role: "assistant", content: null, tool_calls: [call("c1"), call("c2")] },
      { role: "tool", tool_call_id: "c1", content: "corpo della skill" },
    ];
    withResp(a, 1);
    a.cancelResponse(true);

    expect(a.history.some((m) => m.tool_calls?.length)).toBe(false); // c2 never answered
    expect(a.history.some((m) => m.role === "tool")).toBe(false); // …nor c1's half
    expect(a.history.at(-1)!.role).toBe("assistant"); // still spoken, still kept
    expect(a.history.at(-1)!.content).toContain("interrotto");
  });

  test("a complete exchange survives the interrupt", () => {
    const { a } = scripted([]);
    a.history = [
      { role: "user", content: "leggi" },
      { role: "assistant", content: null, tool_calls: [call("c1")] },
      { role: "tool", tool_call_id: "c1", content: "corpo della skill" },
    ];
    withResp(a, 1);
    a.cancelResponse(true);

    expect(a.history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(a.history[2]!.content).toBe("corpo della skill"); // the read is not thrown away
  });

  test('"user continued" rolls the whole turn back, tool cards included', () => {
    const { a } = scripted([]);
    a.history = [
      { role: "assistant", content: "prima risposta" },
      { role: "user", content: "sto cercando" },
      { role: "assistant", content: null, tool_calls: [call("c1")] },
      { role: "tool", tool_call_id: "c1", content: "corpo" },
    ];
    withResp(a, 1);
    a.cancelResponse(false, true);

    expect(a.history.map((m) => m.content)).toEqual(["prima risposta"]);
  });
});

describe("message bookkeeping", () => {
  test("consecutive lines merge, a tool_calls message never does", () => {
    const { a } = scripted([]);
    a.addMessage({ role: "assistant", content: "prima" });
    a.addMessage({ role: "assistant", content: "seconda" });
    expect(a.history).toHaveLength(1); // Gemma wants strict alternation
    expect(a.history[0]!.content).toBe("prima seconda");

    a.addMessage({ role: "assistant", content: "cerco", tool_calls: [call("c1")] });
    a.addMessage({ role: "assistant", content: "poi rispondo" });
    expect(a.history).toHaveLength(3); // the final text must not glue onto the call
    expect(a.history[1]!.tool_calls).toHaveLength(1);
    expect(a.history[2]!.content).toBe("poi rispondo");
  });

  test("an ample window leaves the history alone", async () => {
    const { a } = scripted([{ text: "ok" }]);
    a.contextTotal = 32768;
    for (let i = 0; i < 3; i++) {
      a.addMessage({ role: "user", content: `vecchia ${i} ${"u".repeat(3000)}` });
      a.addMessage({ role: "assistant", content: `risposta ${i} ${"a".repeat(3000)}` });
    }
    await turn(a, "ultima");
    expect(a.history.some((m) => m.content?.startsWith("vecchia 0"))).toBe(true);
    expect(a.history.at(-1)!.content).toBe("ok");
  });

  test("an over-long history loses its oldest turn, never the current one", async () => {
    const { a, requests } = scripted([{ text: "ok" }]);
    a.contextTotal = 60; // → a 6000-char budget: every old turn is over it
    for (let i = 0; i < 3; i++) {
      a.addMessage({ role: "user", content: `vecchia ${i} ${"u".repeat(3000)}` });
      a.addMessage({ role: "assistant", content: `risposta ${i} ${"a".repeat(3000)}` });
    }
    await turn(a, "ultima");

    expect(a.history.some((m) => m.content?.startsWith("vecchia"))).toBe(false);
    expect(a.history.some((m) => m.content === "ultima")).toBe(true);
    const req = requests.at(-1)!;
    expect(req.some((m) => m.content?.startsWith("vecchia"))).toBe(false);
    expect(req.at(-1)!.content).toBe("ultima"); // the turn being answered is always in
  });

  test("a huge tool result in the current turn is truncated, not left to overflow", () => {
    const { a } = scripted([]);
    a.contextTotal = 60; // → a 6000-char budget
    a.history = [
      { role: "user", content: "ultima" },
      { role: "assistant", content: null, tool_calls: [call("c1")] },
      { role: "tool", tool_call_id: "c1", content: `HEAD${"x".repeat(20_000)}TAIL` },
    ];
    (a as unknown as { fitHistory: () => void }).fitHistory();

    const tool = a.history.find((m) => m.role === "tool")!;
    const body = String(tool.content);
    expect(body.length).toBeLessThan(10_000); // whole old turns are gone, this had to shrink
    expect(tool.tool_call_id).toBe("c1");
    expect(body.startsWith("HEAD")).toBe(true);
    expect(body.endsWith("TAIL")).toBe(true);
    expect(body).toContain("troncato");
  });
});
