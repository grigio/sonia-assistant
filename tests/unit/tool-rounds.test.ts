/**
 * A turn must always end on text.
 *
 * `runResponse()` allowed a handful of rounds of function calling and then simply
 * stopped: a model that spent them all on tools (run_command proposed over and over)
 * ended its turn *on* the last tool result. Nothing was spoken, and an empty assistant
 * line went into the history. Six occurrences in data/logs/*.log, each followed by the user
 * asking "puoi rispondere?" into the silence:
 *
 *     16:39:15 … 16:39:27   four run_command rounds
 *     16:39:28 🤖
 *
 * The other half of the story: that last tool-less request can make a small model write
 * its next call as *plain text* ("<toolcall <function=runcommand …"), which the TTS
 * would read aloud — and the mic would then recognise as a user turn (data/logs/restart.log,
 * 17:37:57).
 *
 * These tests pin the fixed behaviour:
 *
 *   - the request after the last tool round carries no tools, and says so in words
 *   - a turn that still yields no text speaks the fallback line, never silence
 *   - tool-call markup is never spoken and never reaches the history
 *   - the number of requests per turn is bounded even if the model asks forever
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../../src/config";
import type { ChatMessage, StreamItem } from "../../src/clients/llm";
import type { ServerEvent } from "../../src/events";
import { Assistant, TOOL_ROUNDS } from "../../src/harness/assistant";
import { Tools } from "../../src/tools";
import { t } from "../../src/i18n";

type Plan = { calls?: { name: string; args: string }[]; text?: string };

const LT = "<";
/** The markup the live model wrote when it ran out of tool rounds (17:37:57). */
const MARKUP =
  LT + "toolcall " + LT + "function=runcommand " + LT + "parameter=command " +
  "ls -la /sys/devices/system/memory/memory188/ " + LT + "/parameter " +
  LT + "parameter=reason Check RAM details " + LT + "/parameter " +
  LT + "/function " + LT + "/toolcall";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * An `Assistant` wired to a scripted LLM / TTS / Player: no network, no audio, no mic.
 * One `Plan` per model request; `offered[i]` is the `tools` argument of that request.
 */
function scripted(plans: Plan[]): {
  a: Assistant;
  requests: ChatMessage[][];
  offered: (Record<string, unknown>[] | null)[];
  segments: string[];
  events: ServerEvent[];
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-rounds-"));
  dirs.push(tmp);

  const cfg = Config.fromEnv();
  cfg.llmEnableTools = true;
  cfg.llmViaPi = false;
  cfg.toolGate = false; // the gate is a network judge: this file tests the round loop
  cfg.locale = "it";     // the fallback line is asserted in Italian — not in the .env
  const a = new Assistant(cfg, null, "null");
  a.log = () => {};
  a.tools = new Tools({
    dataDir: path.join(tmp, "data"),
    announce: () => {},
    cmdMode: "auto",
    history: () => a.history,
  });

  const requests: ChatMessage[][] = [];
  const offered: (Record<string, unknown>[] | null)[] = [];
  const segments: string[] = [];
  const events: ServerEvent[] = [];
  a.emit = (ev) => events.push(ev);

  const stub = a as unknown as { llm: unknown; tts: unknown; player: unknown };
  stub.llm = {
    stream: async function* (
      messages: ChatMessage[],
      tools: Record<string, unknown>[] | null,
    ): AsyncGenerator<StreamItem> {
      requests.push(structuredClone(messages)); // exactly what would go on the wire
      offered.push(tools);
      const plan = plans.shift();
      if (plan?.calls?.length) {
        yield {
          kind: "tool_calls",
          calls: plan.calls.map((c, i) => ({
            id: `c${requests.length}-${i}`,
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
    beginSegment: (s: string) => segments.push(s),
    endSegment: () => {},
    enqueue: () => {},
  };
  return { a, requests, offered, segments, events };
}

/** One spoken turn, resolved when the response task is done. */
async function turn(a: Assistant, text: string): Promise<void> {
  a.startResponse(text, Date.now());
  await a.resp?.task;
}

const clock = () => [{ name: "get_datetime", args: "{}" }];
const toolRounds = (): Plan[] => Array.from({ length: TOOL_ROUNDS }, () => ({ calls: clock() }));

describe("a turn never ends on a tool call", () => {
  test("the request after the last tool round carries no tools, and the answer is spoken", async () => {
    const { a, requests, offered, segments } = scripted([
      ...toolRounds(),
      { text: "Sono le sedici e venti." },
    ]);

    await turn(a, "che ore sono?");

    expect(requests).toHaveLength(TOOL_ROUNDS + 1);
    expect(offered[0]).not.toBeNull();                       // the tool rounds may call
    expect(offered[TOOL_ROUNDS - 1]).not.toBeNull();
    expect(offered[TOOL_ROUNDS]).toBeNull();                 // …the last one must not
    expect(requests[TOOL_ROUNDS]!.some((m) => m.role === "tool")).toBe(true); // results in
    expect(a.history.at(-1)!.role).toBe("assistant");
    expect(a.history.at(-1)!.content).toBe("Sono le sedici e venti.");
    expect(segments).toContain("Sono le sedici e venti.");   // and it reached the TTS
    expect(a.resp).toBeNull();                               // the turn really finished
  });

  test("the tool-less request says so in words (no schema → no markup as text)", async () => {
    const { a, requests } = scripted([...toolRounds(), { text: "Va bene." }]);
    await turn(a, "che ore sono?");

    const last = requests[TOOL_ROUNDS]!;
    expect(last.at(-1)!.role).toBe("user");
    expect(last.at(-1)!.content).toBe(t("it", "prompt.answerNow"));
    // …and it is a request-only nudge: the conversation keeps no synthetic user line
    expect(a.history.filter((m) => m.role === "user")).toHaveLength(1);
    expect(a.history.some((m) => m.content === t("it", "prompt.answerNow"))).toBe(false);
  });

  test("a round with tools on offer gets no nudge", async () => {
    const { a, requests } = scripted([{ calls: clock() }, { text: "Va bene." }]);
    await turn(a, "che ore sono?");
    expect(requests[0]!.at(-1)!.content).toBe("che ore sono?");
    expect(requests.length).toBeLessThanOrEqual(2);
  });

  test("a tool-less round that says nothing still answers (fallback, no empty line)", async () => {
    const { a, requests, segments, events } = scripted([...toolRounds(), {}]);

    await turn(a, "che ore sono?");

    expect(requests).toHaveLength(TOOL_ROUNDS + 1);
    const fallback = t("it", "spoken.noAnswer");
    expect(segments).toContain(fallback);          // the user hears *something*
    expect(a.history.at(-1)!.role).toBe("assistant");
    expect(a.history.at(-1)!.content).toBe(fallback); // …and no empty assistant line
    expect(
      events.some((e) => e.type === "assistant_done" && e.text === fallback),
    ).toBe(true);
  });

  test("a model asking for tools forever gets a bounded number of requests", async () => {
    const { a, requests, segments } = scripted(
      Array.from({ length: TOOL_ROUNDS + 5 }, () => ({ calls: clock() })),
    );

    await turn(a, "che ore sono?");

    expect(requests).toHaveLength(TOOL_ROUNDS + 1); // the tool rounds + the tool-less one
    expect(segments).toContain(t("it", "spoken.noAnswer"));
    expect(a.history.filter((m) => m.role === "tool")).toHaveLength(TOOL_ROUNDS);
    expect(a.history.at(-1)!.content).not.toBe(""); // never an empty assistant line
  });

  test("an answered exchange is kept whole: call and result together", async () => {
    const { a } = scripted([{ calls: clock() }, { text: "Le sedici e venti." }]);
    await turn(a, "che ore sono?");
    expect(a.history.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(a.history[1]!.tool_calls).toHaveLength(1);
  });
});

describe("tool-call markup is never spoken", () => {
  test("a tool-less round that answers with markup speaks the fallback, not the markup", async () => {
    const { a, segments } = scripted([...toolRounds(), { text: MARKUP }]);

    await turn(a, "che ore sono?");

    expect(segments.join(" ")).not.toContain("toolcall");
    expect(segments).toContain(t("it", "spoken.noAnswer"));
    expect(a.history.at(-1)!.content).toBe(t("it", "spoken.noAnswer"));
    expect(a.history.some((m) => String(m.content ?? "").includes("toolcall"))).toBe(false);
  });

  test("markup mixed into a real answer is stripped, the answer is kept", async () => {
    const { a, segments } = scripted([
      ...toolRounds(),
      { text: `Le RAM sono a 9600 MT/s. ${MARKUP}` },
    ]);

    await turn(a, "che ore sono?");

    const said = segments.join(" ");
    expect(said).toContain("Le RAM sono a 9600 MT/s.");
    expect(said).not.toContain("toolcall");
    expect(a.history.at(-1)!.content).toBe("Le RAM sono a 9600 MT/s.");
  });
});
