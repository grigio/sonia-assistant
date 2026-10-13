import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Config } from "../../src/config";
import { LLM } from "../../src/clients/llm";
import type { StreamItem } from "../../src/clients/llm-types";

/** bun test runs every file in one process: remember the real `fetch` here, so an
 *  `afterEach` can drop its own mock without leaving `globalThis.fetch` undefined for
 *  the files that run afterwards — they may need a real one (`src/health.ts` probes). */
const REAL_FETCH = globalThis.fetch;

/** One fake OpenAI streaming answer, fed through the real SSE parser. */
function fakeServer(deltas: Record<string, unknown>[]): { body: unknown; request: any } {
  const seen: any = {};
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const delta of deltas) {
        ctrl.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`),
        );
      }
      ctrl.enqueue(encoder.encode("data: [DONE]\n\n"));
      ctrl.close();
    },
  });
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.url = String(url);
    seen.body = init?.body ? JSON.parse(String(init.body)) : null;
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return { body: seen, request: { seen, restore: () => (globalThis.fetch = original) } };
}

async function collect(cfg: Config, deltas: Record<string, unknown>[]): Promise<StreamItem[]> {
  const fake = fakeServer(deltas);
  try {
    const items: StreamItem[] = [];
    for await (const item of new LLM(cfg).stream([{ role: "user", content: "ciao" }], null)) {
      items.push(item);
    }
    return items;
  } finally {
    fake.request.restore();
  }
}

describe("LLM.stream — reasoning", () => {
  let cfg: Config;
  beforeEach(() => {
    cfg = new Config();
    cfg.llmModel = "test-model";
  });
  afterEach(() => {
    globalThis.fetch = REAL_FETCH;
  });

  test("reasoning_content deltas are yielded as reasoning, not as text", async () => {
    const items = await collect(cfg, [
      { reasoning_content: "devo capire la domanda… " },
      { reasoning_content: "rispondo 391." },
      { content: "Il risultato è 391." },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["reasoning", "reasoning", "text"]);
    expect(items.map((i) => (i as { text: string }).text).join("|")).toBe(
      "devo capire la domanda… |rispondo 391.|Il risultato è 391.",
    );
  });

  test("an inline think block inside content is routed to reasoning", async () => {
    // the tags are built, never written literally (source tools mangle them)
    const LT = "<";
    const items = await collect(cfg, [
      { content: LT + "think>penso un att" },
      { content: "imo…" },
      { content: LT + "/think>Ecco la risposta." },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["reasoning", "reasoning", "text"]);
    expect(items.filter((i) => i.kind === "reasoning").map((i) => i.text).join(""))
      .toBe("penso un attimo…");
    expect((items[items.length - 1] as { text: string }).text).toBe("Ecco la risposta.");
  });

  test("thinking off → enable_thinking:false and the plain token cap", async () => {
    cfg.llmDisableThinking = true;
    await collect(cfg, [{ content: "ciao" }]);
    // the request body is read inside collect(); re-run it capturing the body
    const fake = fakeServer([{ content: "ciao" }]);
    try {
      await new LLM(cfg).stream([{ role: "user", content: "ciao" }], null).next();
      expect(fake.request.seen.body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(fake.request.seen.body.max_tokens).toBe(cfg.llmMaxTokens);
    } finally {
      fake.request.restore();
    }
  });

  test("thinking on → enable_thinking:true + reasoning headroom", async () => {
    cfg.llmDisableThinking = false;
    const fake = fakeServer([{ content: "ciao" }]);
    try {
      await new LLM(cfg).stream([{ role: "user", content: "ciao" }], null).next();
      expect(fake.request.seen.body.chat_template_kwargs).toEqual({ enable_thinking: true });
      expect(fake.request.seen.body.max_tokens).toBe(
        cfg.llmMaxTokens + cfg.llmReasoningBudget,
      );
    } finally {
      fake.request.restore();
    }
  });
});
