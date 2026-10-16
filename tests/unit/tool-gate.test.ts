import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { allowGateRetries, LLM, parseToolGate } from "../../src/clients/llm";
import { Config } from "../../src/config";
import { argSummary, toolDescription } from "../../src/tools";

/** bun test runs every file in one process: remember the real `fetch` here, so an
 *  `afterEach` can drop its own mock without leaving `globalThis.fetch` undefined for
 *  the files that run afterwards — they may need a real one (`src/health.ts` probes). */
const REAL_FETCH = globalThis.fetch;

/** Mock fetch: records every call, answers with `reply` (JSON by default). */
function mockFetch(reply: unknown | ((url: string, body: any) => unknown) = { choices: [] }) {
  const calls: { url: string; body: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: u, body });
    const payload = typeof reply === "function" ? reply(u, body) : reply;
    if ((payload as { http?: number }).http) {
      const p = payload as { http: number; text?: string };
      return new Response(p.text ?? "boom", { status: p.http });
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const gate = (v: string) => ({ choices: [{ message: { content: v } }] });
const PROPOSED = [
  { name: "get_datetime", description: "Current date and time." },
  { name: "run_command", description: "Runs a shell command." },
];

describe("parseToolGate()", () => {
  test("NONE → no tool allowed", () => {
    expect([...parseToolGate("NONE", 2)!]).toEqual([]);
    expect([...parseToolGate("none.", 2)!]).toEqual([]);
  });

  test("numbers are 1-based and map to 0-based indexes", () => {
    expect([...parseToolGate("1", 2)!]).toEqual([0]);
    expect([...parseToolGate("2,3", 3)!]).toEqual([1, 2]);
    expect([...parseToolGate("2 3", 3)!]).toEqual([1, 2]);
  });

  test("out-of-range numbers are ignored, the rest kept", () => {
    expect([...parseToolGate("0, 2, 9", 2)!]).toEqual([1]);
  });

  test("empty or prose without a number → null (no gate at all)", () => {
    expect(parseToolGate("", 2)).toBeNull();
    expect(parseToolGate("the user did not ask for anything", 2)).toBeNull();
  });
});

describe("tool gate — judgeTools() routing", () => {
  let cfg: Config;
  beforeEach(() => {
    cfg = new Config();
    cfg.llmBaseUrl = "http://main:8080/v1";
    cfg.llmModel = "main-model";
  });
  afterEach(() => {
    globalThis.fetch = REAL_FETCH;
  });

  test("shares the judge endpoint/model and carries prompt + tools + user words", async () => {
    cfg.decisionBaseUrl = "http://judge:8098/v1/";
    cfg.decisionModel = "judge-model";
    const m = mockFetch(gate("2"));
    try {
      const allowed = await new LLM(cfg).judgeTools(
        "GATE RULES",
        "Oggi è giovedì 8 ottobre.",
        "Prova",
        PROPOSED,
      );
      expect([...allowed]).toEqual([1]);
      expect(m.calls).toHaveLength(1);
      expect(m.calls[0]!.url).toBe("http://judge:8098/v1/chat/completions"); // no trailing /
      expect(m.calls[0]!.body.model).toBe("judge-model");
      expect(m.calls[0]!.body.temperature).toBe(0);
      expect(m.calls[0]!.body.max_tokens).toBe(16);
      expect(m.calls[0]!.body.chat_template_kwargs).toEqual({ enable_thinking: false });
      const [sys, user] = m.calls[0]!.body.messages;
      expect(sys).toEqual({ role: "system", content: "GATE RULES" });
      expect(user.content).toContain("1. get_datetime — Current date and time.");
      expect(user.content).toContain("Oggi è giovedì 8 ottobre.");
      expect(user.content).toContain('"Prova"');
    } finally {
      m.restore();
    }
  });

  test("NONE → an empty set (every call of the round is denied)", async () => {
    const m = mockFetch(gate("NONE"));
    try {
      const allowed = await new LLM(cfg).judgeTools("G", "", "Ok, grazie.", PROPOSED);
      expect(allowed.size).toBe(0);
    } finally {
      m.restore();
    }
  });

  test("no previous assistant line → no context block, just tools + user message", async () => {
    const m = mockFetch(gate("1"));
    try {
      await new LLM(cfg).judgeTools("G", "", "Che ore sono?", PROPOSED);
      const user = m.calls[0]!.body.messages[1].content as string;
      expect(user).not.toContain("What the assistant just said");
      expect(user).toContain('"Che ore sono?"');
    } finally {
      m.restore();
    }
  });

  test("a failing judge endpoint throws (harness then lets every call through)", async () => {
    cfg.decisionBaseUrl = "http://dead:1/v1";
    const m = mockFetch({ http: 503, text: "down" });
    try {
      await expect(new LLM(cfg).judgeTools("G", "", "Prova", PROPOSED)).rejects.toThrow(
        /tool-gate HTTP 503/,
      );
    } finally {
      m.restore();
    }
  });

  test("an unparsable answer throws (never a silent deny)", async () => {
    const m = mockFetch(gate("maybe?"));
    try {
      await expect(new LLM(cfg).judgeTools("G", "", "Prova", PROPOSED)).rejects.toThrow(
        /unparsable/,
      );
    } finally {
      m.restore();
    }
  });

  test("shows each proposal's arguments and the active skill names", async () => {
    const m = mockFetch(gate("1"));
    try {
      await new LLM(cfg).judgeTools(
        "G",
        "",
        "Usa web surfics.",
        [{ name: "read_skill", description: "Reads a skill.", args: '{"name":"websurfx"}' }],
        "websurfx, yextractor",
      );
      const user = m.calls[0]!.body.messages[1].content as string;
      expect(user).toContain('1. read_skill {"name":"websurfx"} — Reads a skill.');
      expect(user).toContain("Active skills: websurfx, yextractor");
    } finally {
      m.restore();
    }
  });

  test("shows what this answer is already doing for the same request", async () => {
    // data/logs/harness.log 13:38:33-13:44:28: with nothing but the user's words in front of it,
    // the judge read the *follow-up* calls of a request (fetch the title of an id just
    // listed, read the skill it just loaded, open the item the user corrected) as the
    // model's own initiative and denied them — 1.3-8.4 s per denial, one never retried
    const m = mockFetch(gate("1"));
    try {
      await new LLM(cfg).judgeTools(
        "G",
        "",
        "Leggi l'ultimo post.",
        [
          {
            name: "run_command",
            description: "Runs a shell command.",
            args: '{"command":"curl -s https://x.io | grep title"}',
          },
        ],
        "websurfx",
        ["run_command curl -s https://x.io | head → exit code 0 id=50054751 id=50054207"],
      );
      const user = m.calls[0]!.body.messages[1].content as string;
      expect(user).toContain("What this answer is already doing for the same request:");
      expect(user).toContain(
        "1. run_command curl -s https://x.io | head → exit code 0 id=50054751 id=50054207",
      );
      // …and it sits before the proposals, so the judge reads it as their context
      expect(user.indexOf("already doing")).toBeLessThan(user.indexOf("Proposed tools:"));
    } finally {
      m.restore();
    }
  });

  test('nothing ran yet → no "already doing" block', async () => {
    const m = mockFetch(gate("1"));
    try {
      await new LLM(cfg).judgeTools("G", "", "Che ore sono?", PROPOSED);
      expect(m.calls[0]!.body.messages[1].content as string).not.toContain("already doing");
    } finally {
      m.restore();
    }
  });

  test("no skills / no args → the message reads exactly as before", async () => {
    const m = mockFetch(gate("1"));
    try {
      await new LLM(cfg).judgeTools("G", "", "Che ore sono?", PROPOSED);
      const user = m.calls[0]!.body.messages[1].content as string;
      expect(user).not.toContain("Active skills");
      expect(user).toContain("1. get_datetime — Current date and time.");
    } finally {
      m.restore();
    }
  });
});

describe("allowGateRetries()", () => {
  const keys = ['read_skill {"name":"websurfx"}', "get_datetime "];

  test("the first denial is only recorded (the call stays denied)", () => {
    const denied = new Map<string, number>();
    const retry = allowGateRetries(new Set(), keys, denied);
    expect([...retry]).toEqual([]);
    expect(denied.size).toBe(2);
  });

  test("the same call denied again in a later round is allowed (…↻ in the log)", () => {
    const denied = new Map<string, number>();
    allowGateRetries(new Set(), keys, denied); // round 1: NONE
    const retry = allowGateRetries(new Set(), keys, denied); // round 2: same proposal
    expect([...retry]).toEqual([0, 1]);
    expect([...retry].every((i) => denied.has(keys[i]!))).toBe(true);
  });

  test("a changed call (other skill) is denied on its own first time", () => {
    const denied = new Map<string, number>();
    allowGateRetries(new Set(), [keys[0]!], denied);
    const retry = allowGateRetries(new Set(), ['read_skill {"name":"reddit"}'], denied);
    expect([...retry]).toEqual([]);
    expect(denied.size).toBe(2);
  });

  test("already-allowed calls are untouched and never recorded", () => {
    const denied = new Map<string, number>();
    const retry = allowGateRetries(new Set([1]), keys, denied);
    expect([...retry]).toEqual([]);
    expect(denied.has(keys[1]!)).toBe(false);
    expect(denied.size).toBe(1);
  });
});

describe("argSummary()", () => {
  test("arguments on one line for the judge", () => {
    expect(argSummary('{"name":"websurfx"}')).toBe('{"name":"websurfx"}');
    expect(argSummary('{"command": "curl a\n&& grep b"}')).toBe('{"command": "curl a && grep b"}');
  });

  test("nothing to show → empty string (no bare {} in front of the judge)", () => {
    expect(argSummary(undefined)).toBe("");
    expect(argSummary("   ")).toBe("");
    expect(argSummary("{}")).toBe("");
  });

  test("a long shell command is clipped", () => {
    const out = argSummary(`{"command":"${"x".repeat(500)}"}`);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("tool gate — toolDescription()", () => {
  test("knows every harness tool by name", () => {
    expect(toolDescription("get_datetime")).toContain("date and time");
    expect(toolDescription("run_command")).toContain("shell command");
    expect(toolDescription("add_note")).toContain("note");
  });

  test("unknown tool → empty description (the judge still sees its name)", () => {
    expect(toolDescription("nope")).toBe("");
  });
});
