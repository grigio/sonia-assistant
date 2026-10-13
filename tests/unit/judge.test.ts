import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Config } from "../../src/config";
import { LLM } from "../../src/clients/llm";

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
    const payload =
      typeof reply === "function" ? reply(u, body) : reply;
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

const DECISION = "Answer LISTEN or REPLY.";

function verdict(v: string) {
  return { choices: [{ message: { content: v } }] };
}

describe("turn-taking judge — routing", () => {
  let cfg: Config;
  beforeEach(() => {
    cfg = new Config();
    cfg.llmBaseUrl = "http://main:8080/v1";
    cfg.llmModel = "main-model";
  });
  afterEach(() => {
    globalThis.fetch = REAL_FETCH;
  });

  test("empty DECISION_* → the judge shares the main leg (unchanged behaviour)", async () => {
    const m = mockFetch(verdict("REPLY"));
    try {
      const v = await new LLM(cfg).decide(DECISION, "user: ciao\n", "…");
      expect(v).toBe("speak");
      expect(m.calls[0]!.url).toBe("http://main:8080/v1/chat/completions");
      expect(m.calls[0]!.body.model).toBe("main-model");
      expect(m.calls[0]!.body.max_tokens).toBe(4);
      expect(m.calls[0]!.body.messages[0]).toEqual({ role: "system", content: DECISION });
    } finally {
      m.restore();
    }
  });

  test("DECISION_BASE_URL + DECISION_MODEL → their own endpoint and model", async () => {
    cfg.decisionBaseUrl = "http://judge:8098/v1/";
    cfg.decisionModel = "judge-model";
    const m = mockFetch(verdict("listen"));
    try {
      const llm = new LLM(cfg);
      expect(llm.judgeDedicated).toBe(true);
      const v = await llm.decide(DECISION, "", "…");
      expect(v).toBe("listen");
      expect(m.calls[0]!.url).toBe("http://judge:8098/v1/chat/completions"); // no trailing /
      expect(m.calls[0]!.body.model).toBe("judge-model");
      expect(m.calls[0]!.body.temperature).toBe(0);
      expect(m.calls[0]!.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    } finally {
      m.restore();
    }
  });

  test("DECISION_MODEL alone → main endpoint, judge model (router mode)", async () => {
    cfg.decisionModel = "tiny";
    const m = mockFetch(verdict("REPLY"));
    try {
      await new LLM(cfg).decide(DECISION, "", "…");
      expect(m.calls[0]!.url).toBe("http://main:8080/v1/chat/completions");
      expect(m.calls[0]!.body.model).toBe("tiny");
    } finally {
      m.restore();
    }
  });

  test("pi leg + DECISION_BASE_URL → API judge, pi is never spawned", async () => {
    cfg.llmViaPi = true;
    cfg.decisionBaseUrl = "http://judge:8098/v1";
    const m = mockFetch(verdict("REPLY"));
    try {
      await new LLM(cfg).decide(DECISION, "", "…");
      expect(m.calls).toHaveLength(1);
      expect(m.calls[0]!.url).toBe("http://judge:8098/v1/chat/completions");
    } finally {
      m.restore();
    }
  });

  test("a failed judge endpoint throws (harness catches it and falls back to «speak»)", async () => {
    cfg.decisionBaseUrl = "http://dead:1/v1";
    const m = mockFetch({ http: 503, text: "down" });
    try {
      await expect(new LLM(cfg).decide(DECISION, "", "…")).rejects.toThrow();
    } finally {
      m.restore();
    }
  });
});

describe("turn-taking judge — warmupJudge()", () => {
  let cfg: Config;
  beforeEach(() => {
    cfg = new Config();
    cfg.llmBaseUrl = "http://main:8080/v1";
    cfg.llmModel = "main-model";
  });
  afterEach(() => {
    globalThis.fetch = REAL_FETCH;
  });

  test("primes the decision prefix on the judge endpoint", async () => {
    cfg.decisionBaseUrl = "http://judge:8098/v1";
    cfg.decisionModel = "judge-model";
    const m = mockFetch(verdict("REPLY"));
    try {
      await new LLM(cfg).warmupJudge(DECISION);
      expect(m.calls).toHaveLength(1);
      expect(m.calls[0]!.url).toBe("http://judge:8098/v1/chat/completions");
      expect(m.calls[0]!.body.model).toBe("judge-model");
      expect(m.calls[0]!.body.max_tokens).toBe(4);
      expect(m.calls[0]!.body.messages[0]).toEqual({ role: "system", content: DECISION });
    } finally {
      m.restore();
    }
  });

  test("DECISION_MODE=off → nothing is primed", async () => {
    cfg.decisionMode = "off";
    const m = mockFetch(verdict("REPLY"));
    try {
      await new LLM(cfg).warmupJudge(DECISION);
      expect(m.calls).toHaveLength(0);
    } finally {
      m.restore();
    }
  });

  test("pi leg without judge knobs → nothing to prime", async () => {
    cfg.llmViaPi = true;
    const m = mockFetch(verdict("REPLY"));
    try {
      await new LLM(cfg).warmupJudge(DECISION);
      expect(m.calls).toHaveLength(0);
    } finally {
      m.restore();
    }
  });

  test("failure throws, so the caller can log a warning", async () => {
    cfg.decisionBaseUrl = "http://dead:1/v1";
    const m = mockFetch({ http: 502, text: "down" });
    try {
      await expect(new LLM(cfg).warmupJudge(DECISION)).rejects.toThrow(/judge warmup HTTP 502/);
    } finally {
      m.restore();
    }
  });
});
