/** The context meter: where n_ctx comes from, and how the two legs report token usage. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LLM } from "../../src/clients/llm";
import type { StreamItem } from "../../src/clients/llm-types";
import { PiSession } from "../../src/clients/pi";
import { Config } from "../../src/config";
import {
  contextsFromPiList,
  contextsFromServerModels,
  parseContextSize,
  piModelRows,
} from "../../src/context";

/** bun test runs every file in one process: remember the real `fetch` here, so an
 *  `afterEach` can drop its own mock without leaving `globalThis.fetch` undefined for
 *  the files that run afterwards — they may need a real one (`src/health.ts` probes). */
const REAL_FETCH = globalThis.fetch;

// ── n_ctx parsing ──────────────────────────────────────────────────────────

describe("parseContextSize", () => {
  test("plain numbers are taken verbatim", () => {
    expect(parseContextSize("32768")).toBe(32768);
    expect(parseContextSize("8192")).toBe(8192);
  });

  test('K/M/G are the powers of ten pi displays (32768 → "32.8K")', () => {
    expect(parseContextSize("32.8K")).toBe(32800);
    expect(parseContextSize("128K")).toBe(128000);
    expect(parseContextSize("1M")).toBe(1_000_000);
    expect(parseContextSize("1.5M")).toBe(1_500_000);
    expect(parseContextSize("200k")).toBe(200000);
  });

  test('junk and zero mean "unknown"', () => {
    expect(parseContextSize("")).toBe(0);
    expect(parseContextSize("n/a")).toBe(0);
    expect(parseContextSize("0")).toBe(0);
    expect(parseContextSize("-1")).toBe(0);
  });
});

describe("contextsFromServerModels (GET /v1/models)", () => {
  test("loaded models report meta.n_ctx", () => {
    const out = contextsFromServerModels({
      data: [{ id: "gemma", meta: { n_ctx: 32768, n_ctx_train: 262144 } }],
    });
    expect(out.gemma).toBe(32768);
  });

  test("unloaded models fall back to --ctx-size in status.args", () => {
    const out = contextsFromServerModels({
      data: [
        {
          id: "qwen",
          status: { value: "unloaded", args: ["llama-server", "--ctx-size", "32768", "--jinja"] },
        },
      ],
    });
    expect(out.qwen).toBe(32768);
  });

  test("aliases share the id's context window", () => {
    const out = contextsFromServerModels({
      data: [{ id: "a", aliases: ["a", "a-alias"], meta: { n_ctx: 8192 } }],
    });
    expect(out.a).toBe(8192);
    expect(out["a-alias"]).toBe(8192);
  });

  test("malformed payloads yield no context instead of throwing", () => {
    expect(contextsFromServerModels(null)).toEqual({});
    expect(contextsFromServerModels({})).toEqual({});
    expect(contextsFromServerModels({ data: [{ id: "x" }] })).toEqual({});
    expect(contextsFromServerModels("not json")).toEqual({});
  });
});

describe("contextsFromPiList (pi --list-models)", () => {
  const LIST = [
    "provider       model                              context  max-out  thinking",
    "llamacpp       gemma-4-12b-it-qat-q4_0            32.8K    8.2K     yes",
    "llamacpp       Qwen3.6-35B-compact                18.4K    8.2K     yes",
    "opencode       claude-fable-5                     1M       128K     yes",
    'Warning: no models match pattern "x"',
    "",
  ].join("\n");

  test("one entry per id, header and warnings dropped", () => {
    const rows = piModelRows(LIST);
    expect(rows.map((r) => r.id)).toEqual([
      "llamacpp/gemma-4-12b-it-qat-q4_0",
      "llamacpp/Qwen3.6-35B-compact",
      "opencode/claude-fable-5",
    ]);
  });

  test("the context column becomes the bar's denominator", () => {
    const out = contextsFromPiList(LIST);
    expect(out["llamacpp/gemma-4-12b-it-qat-q4_0"]).toBe(32800);
    expect(out["opencode/claude-fable-5"]).toBe(1_000_000);
  });

  test("the first duplicate wins, like the model ids", () => {
    const out = contextsFromPiList("p a 100 1 yes\np a 999 1 yes\n");
    expect(out["p/a"]).toBe(100);
  });
});

// ── usage → StreamItem ─────────────────────────────────────────────────────

describe("LLM.stream — context usage", () => {
  let cfg: Config;
  let restore: (() => void) | null = null;

  beforeEach(() => {
    cfg = new Config();
    cfg.llmModel = "test-model";
  });
  afterEach(() => {
    restore?.();
    restore = null;
    globalThis.fetch = REAL_FETCH;
  });

  test("asks for the usage chunk and yields it", async () => {
    const encoder = new TextEncoder();
    const seen: Record<string, any> = {};
    const chunks: unknown[] = [
      { choices: [{ delta: { content: "Ciao!" } }] },
      { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 } },
      "[DONE]",
    ];
    const original = globalThis.fetch;
    restore = () => (globalThis.fetch = original);
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.body = init?.body ? JSON.parse(String(init.body)) : null;
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          for (const c of chunks) {
            ctrl.enqueue(
              encoder.encode(
                c === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(c)}\n\n`,
              ),
            );
          }
          ctrl.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const items: StreamItem[] = [];
    for await (const item of new LLM(cfg).stream([{ role: "user", content: "ciao" }], null)) {
      items.push(item);
    }
    expect(seen.body.stream_options).toEqual({ include_usage: true });
    expect(items.map((i) => i.kind)).toEqual(["text", "usage"]);
    expect(items[1]).toEqual({ kind: "usage", prompt: 1200, completion: 40 });
  });

  test("contextWindow reads the n_ctx the model list already gave us", async () => {
    const original = globalThis.fetch;
    restore = () => (globalThis.fetch = original);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "test-model", status: { args: ["llama-server", "--ctx-size", "32768"] } },
            { id: "other", meta: { n_ctx: 8192 } },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const llm = new LLM(cfg);
    expect(await llm.check()).toEqual(["test-model", "other"]);
    expect(await llm.contextWindow()).toBe(32768);

    cfg.llmModel = "other";
    expect(await llm.contextWindow()).toBe(8192);

    cfg.llmContextWindow = 16384; // explicit env override wins over everything
    expect(await llm.contextWindow()).toBe(16384);
  });
});

// ── the pi leg ─────────────────────────────────────────────────────────────

describe("PiSession", () => {
  let dir = "";
  let bin = "";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fake-"));
    bin = path.join(dir, "pi-fake");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A pi that answers with one streamed message and its usage, no model needed. */
  function writeFakePi(lines: string[]): void {
    fs.writeFileSync(bin, `#!/usr/bin/env bash\ncat <<'JSON'\n${lines.join("\n")}\nJSON\n`, {
      mode: 0o755,
    });
  }

  test("message_end usage becomes one `usage` item", async () => {
    writeFakePi([
      '{"type":"message_start","message":{"role":"assistant","content":[]}}',
      '{"type":"message_update","usage":{"input":1010,"output":3,"totalTokens":1013},' +
        '"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Ciao."}}',
      '{"type":"message_end","message":{"role":"assistant",' +
        '"content":[{"type":"text","text":"Ciao."}],"usage":{"input":1010,"output":12}}}',
    ]);
    const cfg = new Config();
    cfg.piCmd = bin;
    cfg.piCwd = dir;
    const items: StreamItem[] = [];
    for await (const item of new PiSession(cfg).stream([{ role: "user", content: "ciao" }])) {
      items.push(item);
    }
    expect(items.map((i) => i.kind)).toEqual(["text", "usage"]);
    expect(items[1]).toEqual({ kind: "usage", prompt: 1010, completion: 12 });
  });

  test("a message with no usage at all yields none (nothing to measure)", async () => {
    writeFakePi([
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
    ]);
    const cfg = new Config();
    cfg.piCmd = bin;
    cfg.piCwd = dir;
    const items: StreamItem[] = [];
    for await (const item of new PiSession(cfg).stream([{ role: "user", content: "ciao" }])) {
      items.push(item);
    }
    expect(items.map((i) => i.kind)).toEqual(["text"]);
  });

  test("contextWindows() mirrors the model list column", async () => {
    writeFakePi([]); // `pi --list-models` prints nothing here → the id list falls back
    const cfg = new Config();
    cfg.piCmd = bin;
    cfg.piCwd = dir;
    const session = new PiSession(cfg);
    expect(await session.contextWindows()).toEqual({});
  });
});
