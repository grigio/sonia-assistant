import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LLM } from "../../src/clients/llm";
import type { StreamItem } from "../../src/clients/llm-types";
import { Config } from "../../src/config";
import { sleep } from "../../src/util";

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
        ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
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
      { content: `${LT}think>penso un att` },
      { content: "imo…" },
      { content: `${LT}/think>Ecco la risposta.` },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["reasoning", "reasoning", "text"]);
    expect(
      items
        .filter((i) => i.kind === "reasoning")
        .map((i) => i.text)
        .join(""),
    ).toBe("penso un attimo…");
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
      expect(fake.request.seen.body.max_tokens).toBe(cfg.llmMaxTokens + cfg.llmReasoningBudget);
    } finally {
      fake.request.restore();
    }
  });
});

describe("LLM.stream — cancellation and failure", () => {
  let cfg: Config;
  beforeEach(() => {
    cfg = new Config();
    cfg.llmModel = "test-model";
  });
  afterEach(() => {
    globalThis.fetch = REAL_FETCH;
  });

  test("the caller's signal reaches the request (a barge-in stops llama-server)", async () => {
    // Before the signal was threaded in, the request only had its own 300 s timeout:
    // the generator was abandoned while the server kept generating.
    const ctl = new AbortController();
    const encoder = new TextEncoder();
    const seen: { signal: AbortSignal | null } = { signal: null };
    const original = globalThis.fetch;
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      seen.signal = init?.signal ?? null;
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          // one real delta, so the first next() has something to yield and the
          // generator stays suspended on the open body
          ctrl.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "sto" } }] })}\n\n`,
            ),
          );
          // a real fetch errors the body on abort — the mock must do the same, or the
          // generator would wait forever instead of being cancelled
          init?.signal?.addEventListener("abort", () => {
            ctrl.error(new DOMException("aborted", "AbortError"));
          });
          // deliberately left open: only the abort can stop this
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;
    try {
      const stream = new LLM(cfg).stream([{ role: "user", content: "ciao" }], null, ctl.signal);
      const first = await stream.next();
      expect(first.value).toEqual({ kind: "text", text: "sto" });
      // the request carries the caller's signal, not a private timeout alone
      expect(seen.signal?.aborted).toBe(false);
      ctl.abort();
      // Without the signal reaching fetch, `next()` waits on a body nobody will ever
      // close — the test would hang instead of failing, so bound it.
      const settled = await Promise.race([
        stream.next().then(
          () => "resolved",
          () => "rejected",
        ),
        sleep(2000).then(() => "hung"),
      ]);
      expect(settled).toBe("rejected");
      expect(seen.signal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("an HTTP error names the leg that failed and shows the body", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) =>
      new Response("model not loaded", { status: 503 })) as typeof fetch;
    try {
      const it = new LLM(cfg).stream([{ role: "user", content: "ciao" }], null);
      await expect(it.next()).rejects.toThrow(/LLM HTTP 503: model not loaded/);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("decide() reports an HTTP failure instead of parsing it as a verdict", async () => {
    // r.json() on an error page used to yield "listen" — the worst possible answer to a
    // broken judge: it silently kept the mic open.
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) =>
      new Response("<html>502</html>", { status: 502 })) as typeof fetch;
    try {
      await expect(new LLM(cfg).decide("prompt", "tail", "ciao")).rejects.toThrow(/judge HTTP 502/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
