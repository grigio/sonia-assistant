/**
 * The gate must recognise a skill the user only *spoke*, and must not stall the turn.
 *
 * data/logs/harness.log 11:35:48: the user says "Usa web surfics." (ASR; the skill is
 * websurfx), the model proposes the right call — `read_skill {"name":"websurfx"}` — and
 * the judge denies it six times, because it was shown only the bare tool name and its
 * input never changes (temperature 0, same words every round). Six gated rounds, first
 * token at 15.2 s, then an answer about an unrelated topic.
 *
 * These tests pin the fixed behaviour:
 *
 *   - the judge sees each proposal's *arguments* and the active skill names
 *   - a call denied once runs when the model proposes it identically again (…↻)
 *   - a different call (other arguments) is denied on its own first appearance
 *   - a refused call is announced as ⛔ blocked, never as "✅ ok" (its result is a
 *     message, the command never ran)
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../../src/config";
import type { ChatMessage, StreamItem } from "../../src/clients/llm";
import type { ToolPayload } from "../../src/clients/toolcards";
import { Assistant } from "../../src/harness/assistant";
import { Skills } from "../../src/skills";
import { Tools } from "../../src/tools";
import { t } from "../../src/i18n";

type Plan = { calls?: { name: string; args: string }[]; text?: string };
type JudgeCall = {
  prevAssistant: string;
  userText: string;
  proposed: { name: string; description: string; args?: string }[];
  skills: string;
  doing: string[];
};

const SKILL_MD = "---\nname: demo\ndescription: A demo skill.\n---\n# Demo\nrun scripts/x.ts\n";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * An `Assistant` with a scripted model and a scripted judge: `verdict` decides each
 * `judgeTools()` call (default: deny everything), `judges` records what it was asked.
 */
function scripted(
  plans: Plan[],
  verdict: (call: JudgeCall) => Set<number> = () => new Set(),
): {
  a: Assistant;
  judges: JudgeCall[];
  logs: string[];
  results: string[]; // the `content` of every tool result, in order
  payloads: ToolPayload[]; // what reached the UI, in order
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-gate-"));
  dirs.push(tmp);
  const dir = path.join(tmp, "skills");
  fs.mkdirSync(path.join(dir, "demo"), { recursive: true });
  fs.writeFileSync(path.join(dir, "demo", "SKILL.md"), SKILL_MD);

  const cfg = Config.fromEnv();
  cfg.llmEnableTools = true;
  cfg.llmViaPi = false;
  cfg.toolGate = true;
  cfg.locale = "it";
  const a = new Assistant(cfg, null, "null");
  const logs: string[] = [];
  a.log = (line: string) => logs.push(line);
  a.skills = new Skills({ dir, dataDir: path.join(tmp, "data") });
  a.tools = new Tools({
    dataDir: path.join(tmp, "data"),
    announce: () => {},
    cmdMode: "auto",
    skills: a.skills,
    history: () => a.history,
  });

  const judges: JudgeCall[] = [];
  const results: string[] = [];
  const payloads: ToolPayload[] = [];
  const onTool = a.onTool.bind(a); // it also writes the 🔧/⛔ log lines: chain, don't shadow
  a.onTool = (ev: ToolPayload) => {
    payloads.push(ev);
    if (ev.phase === "end" && typeof ev.result === "string") results.push(ev.result);
    onTool(ev);
  };

  const stub = a as unknown as { llm: unknown; tts: unknown; player: unknown };
  stub.llm = {
    stream: async function* (messages: ChatMessage[]): AsyncGenerator<StreamItem> {
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
      void messages;
    },
    judgeTools: async (
      gatePrompt: string,
      prevAssistant: string,
      userText: string,
      proposed: JudgeCall["proposed"],
      skills: string,
      doing: string[] = [],
    ): Promise<Set<number>> => {
      void gatePrompt;
      const call = { prevAssistant, userText, proposed, skills, doing };
      judges.push(call);
      return verdict(call);
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
  return { a, judges, logs, results, payloads };
}

/** The 11:35:48 round: a skill named only through its spoken approximation. */
const skillRound = (): Plan => ({
  calls: [{ name: "read_skill", args: '{"name":"demo"}' }],
});

describe("the tool gate — what the judge is shown", () => {
  test("the proposal carries its arguments and the active skill names", async () => {
    const { a, judges } = scripted([skillRound(), { text: "Va bene." }]);
    a.startResponse("usa demo surfix", Date.now());
    await a.resp?.task;

    expect(judges).toHaveLength(1);
    expect(judges[0]!.proposed[0]!.args).toBe('{"name":"demo"}');
    expect(judges[0]!.skills).toBe("demo");
    expect(judges[0]!.userText).toBe("usa demo surfix");
  });
});

describe("the tool gate — a denied call proposed again", () => {
  test("denied once, run on the identical retry (↻) instead of stalling the turn", async () => {
    const { a, results, logs } = scripted([skillRound(), skillRound(), skillRound(), { text: "Fatto." }]);

    a.startResponse("usa demo surfix", Date.now());
    await a.resp?.task;

    const gated = t("it", "gated.tool");
    expect(results[0]).toBe(gated);              // round 1: the judge says no
    expect(results[1]).toContain("# Demo");      // round 2: identical call → it ran
    expect(results[2]).toContain("already in the messages above"); // …and stayed allowed
    expect(logs.filter((l) => l.includes("read_skill↻")).length).toBeGreaterThanOrEqual(1);
    expect(a.history.at(-1)!.content).toBe("Fatto."); // the turn still ended on text
  });

  test("other arguments are a new call: denied on their own first appearance", async () => {
    const { a, results } = scripted([
      skillRound(),
      { calls: [{ name: "read_skill", args: '{"name":"other"}' }] },
      skillRound(),
      { text: "Fatto." },
    ]);

    a.startResponse("usa demo surfix", Date.now());
    await a.resp?.task;

    const gated = t("it", "gated.tool");
    expect(results[0]).toBe(gated);  // "demo" denied → recorded
    expect(results[1]).toBe(gated);  // "other" ≠ "demo" → denied on its own first time
    expect(results[2]).toContain("# Demo"); // "demo" again → allowed
  });

  test("an allowed call is never recorded nor retried by the rule", async () => {
    const { a, results, logs } = scripted(
      [skillRound(), skillRound(), { text: "Fatto." }],
      () => new Set([0]), // the judge always allows
    );

    a.startResponse("usa demo surfix", Date.now());
    await a.resp?.task;

    expect(results[0]).toContain("# Demo");  // the judge allows → runs both rounds
    expect(results[1]).toContain("already in the messages above");
    expect(logs.some((l) => l.includes("read_skill↻"))).toBe(false);
    expect(logs.some((l) => l.includes("read_skill✗"))).toBe(false);
  });

  test("a refused call is ⛔ blocked on the card and in the log, never «✅ ok»", async () => {
    const { a, payloads, logs } = scripted([skillRound(), { text: "Fatto." }]);

    a.startResponse("usa demo surfix", Date.now());
    await a.resp?.task;

    const ends = payloads.filter((p) => p.phase === "end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.blocked).toBe(true);
    expect(ends[0]!.error).toBe(false);   // not an error either: it never ran
    expect(ends[0]!.info).toBe(t("it", "tool.gatedInfo"));
    expect(logs.some((l) => l.includes("⛔ read_skill"))).toBe(true);
    expect(logs.some((l) => l.includes("⚙ read_skill"))).toBe(false);
  });

  test("a call that ran keeps «✅ ok»: no blocked flag, no ⛔ in the log", async () => {
    const { a, payloads, logs } = scripted(
      [skillRound(), { text: "Fatto." }],
      () => new Set([0]),
    );

    a.startResponse("usa demo surfix", Date.now());
    await a.resp?.task;

    const ends = payloads.filter((p) => p.phase === "end");
    expect(ends[0]!.blocked).toBeUndefined();
    expect(logs.some((l) => l.includes("⚙ read_skill"))).toBe(true);
    expect(logs.some((l) => l.includes("⛔"))).toBe(false);
  });
});

/**
 * The follow-up calls of one request used to be judged again from scratch — the same
 * user words, a new command, no trace of what the answer was already doing — and denied
 * as "the model's own initiative": data/logs/harness.log 13:38:38 → 13:44:28, four denials of
 * 1.3-8.4 s each, the last one never retried, so the assistant answered with an invented
 * item (13:45:01). A tool the gate already allowed for this turn stays allowed.
 */
describe("the tool gate — one tool, one decision per turn", () => {
  const cmd = (line: string): Plan => ({ calls: [{ name: "run_command", args: `{"command":"${line}"}` }] });

  test("a second call of an already-allowed tool is not asked about again", async () => {
    const { a, judges, results, logs } = scripted(
      [cmd("echo primo"), cmd("echo secondo"), { text: "Fatto." }],
      () => new Set([0]),
    );

    a.startResponse("leggi l'ultimo post", Date.now());
    await a.resp?.task;

    expect(judges).toHaveLength(1);            // round 2: the tool is already allowed
    expect(results[0]).toContain("primo");
    expect(results[1]).toContain("secondo");  // …and it ran without a second question
    expect(logs.some((l) => l.includes("≡ already allowed"))).toBe(true);
    expect(logs.some((l) => l.includes("run_command✗"))).toBe(false);
    expect(a.history.at(-1)!.content).toBe("Fatto.");
  });

  test("a tool the gate never allowed is still judged on its own, with the context", async () => {
    const { a, judges, results } = scripted(
      [skillRound(), cmd("echo dopo"), { text: "Fatto." }],
      () => new Set([0]),
    );

    a.startResponse("usa demo e poi stampa", Date.now());
    await a.resp?.task;

    expect(judges).toHaveLength(2);
    expect(judges[1]!.proposed[0]!.name).toBe("run_command"); // a new tool → asked
    // …and the judge sees the call that already ran for this very request
    expect(judges[1]!.doing).toHaveLength(1);
    expect(judges[1]!.doing[0]).toContain('read_skill {"name":"demo"}');
    expect(judges[1]!.doing[0]).toContain("# Demo");
    expect(results[1]).toContain("dopo");
  });

  test("a denied call is never carried: a new tool is denied on its first appearance", async () => {
    const { a, results } = scripted(
      [skillRound(), skillRound(), cmd("echo dopo"), cmd("echo dopo"), { text: "Fatto." }],
      (call) =>
        new Set(
          call.proposed.map((_, i) => i).filter((i) => call.proposed[i]!.name !== "run_command"),
        ),
    );

    a.startResponse("usa demo surfix", Date.now());
    await a.resp?.task;

    const gated = t("it", "gated.tool");
    expect(results[0]).toContain("# Demo");   // read_skill allowed → carried next round
    expect(results[1]).toContain("already in the messages above");
    expect(results[2]).toBe(gated);           // run_command: first appearance, denied
    expect(results[3]).toContain("dopo");     // identical retry → the ↻ rule runs it
  });
});
