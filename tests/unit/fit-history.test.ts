/**
 * Keeping the history inside the model's window (`Assistant.fitHistory`, budget in
 * `context.ts`).
 *
 * Two things are pinned here, both of them "the boring failure nobody notices until the
 * server answers 400":
 *
 *  - the budget itself: sized by n_ctx when a model list reports it, by the chars/token
 *    the *last real request* measured rather than by a fixed guess;
 *  - **n_ctx unknown must no longer mean "never trim"** — that was the old behaviour, and
 *    with `LLM_CONTEXT_WINDOW=0` (the default) and a `/v1/models` that reports no
 *    `meta.n_ctx` the history grew until llama-server refused the request.
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StreamItem } from "../../src/clients/llm";
import { Config } from "../../src/config";
import {
  CHARS_PER_TOKEN,
  CTX_ASSUMED_WINDOW,
  CTX_MIN_BUDGET_CHARS,
  estimateCharsPerToken,
  historyBudget,
} from "../../src/context";
import { Assistant } from "../../src/harness/assistant";
import { Tools } from "../../src/tools";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("historyBudget", () => {
  test("n_ctx known: the window minus the 4k reserved for prompt + reply", () => {
    expect(historyBudget(32768, 3)).toBe((32768 - 4000) * 3);
    expect(historyBudget(8192, 4)).toBe((8192 - 4000) * 4);
  });

  test('n_ctx unknown: a conservative window, never "no limit"', () => {
    const budget = historyBudget(0, CHARS_PER_TOKEN);
    expect(budget).toBe((CTX_ASSUMED_WINDOW - 4000) * CHARS_PER_TOKEN);
    expect(budget).toBeGreaterThan(0);
    // …and never below the floor that keeps the last exchanges
    expect(historyBudget(1000, 0.5)).toBe(CTX_MIN_BUDGET_CHARS);
  });
});

describe("estimateCharsPerToken", () => {
  test("measures the ratio of the last request, clamped against one odd turn", () => {
    expect(estimateCharsPerToken(30_000, 10_000)).toBe(3);
    expect(estimateCharsPerToken(60_000, 10_000)).toBe(6); // never above
    expect(estimateCharsPerToken(10_000, 10_000)).toBe(1.5); // never below
  });

  test("nothing measured yet → the prose/shell-output default", () => {
    expect(estimateCharsPerToken(0, 0)).toBe(CHARS_PER_TOKEN);
    expect(estimateCharsPerToken(-5, 100)).toBe(CHARS_PER_TOKEN);
    expect(estimateCharsPerToken(NaN, NaN)).toBe(CHARS_PER_TOKEN);
  });
});

/** An `Assistant` wired to a scripted LLM/TTS/Player: no network, no audio, no mic. */
function scripted(): Assistant {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-fit-"));
  dirs.push(dataDir);
  const cfg = Config.fromEnv();
  cfg.dataDir = dataDir;
  cfg.chatPersist = false;
  const a = new Assistant(cfg, null, "null");
  a.log = () => {};
  a.tools = new Tools({ dataDir, announce: () => {}, cmdMode: "off" });
  const stub = a as unknown as { llm: unknown; tts: unknown; player: unknown };
  stub.llm = {
    stream: async function* (): AsyncGenerator<StreamItem> {
      yield { kind: "text", text: "ok" };
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

describe("fitHistory", () => {
  test("a history bigger than the window loses its oldest turns, never the current one", async () => {
    const a = scripted();
    a.contextTotal = 8192; // budget: (8192-4000) × 3 ≈ 12.6k chars
    for (let i = 0; i < 10; i++)
      a.addMessage({ role: "user", content: `turno ${i} ${"x".repeat(3000)}` });
    expect(a.history).toHaveLength(10);

    await turn(a, "adesso");
    expect(a.history.length).toBeLessThan(10); // the oldest ones went
    expect(a.history.some((m) => m.content === "adesso")).toBe(true); // never the turn being answered
  });

  test('n_ctx unknown still trims (it used to mean "grow until the server refuses")', async () => {
    const a = scripted();
    a.contextTotal = 0; // no model list ever reported it
    for (let i = 0; i < 10; i++)
      a.addMessage({ role: "user", content: `q${i} ${"y".repeat(6000)}` });

    await turn(a, "sarà?");
    expect(a.history.length).toBeLessThan(10);
    expect(a.history.some((m) => m.content === "sarà?")).toBe(true);
    expect(a.history.some((m) => m.content === `q0 ${"y".repeat(6000)}`)).toBe(false); // oldest went
  });

  test("a history well inside the window is left alone", async () => {
    const a = scripted();
    a.contextTotal = 32768; // budget: (32768-4000) × 3 ≈ 86k chars
    for (let i = 0; i < 5; i++) a.addMessage({ role: "user", content: `turno ${i}` });

    await turn(a, "breve");
    expect(a.history).toHaveLength(7); // 5 + the question just asked + its answer
    expect(a.history.some((m) => m.content === "turno 0")).toBe(true);
  });

  test("the invariant: after a turn the history is inside its budget again", async () => {
    const a = scripted();
    a.contextTotal = 8192; // budget ≈ (8192 - 4000) × 3 = 12576 chars
    const budget = historyBudget(8192);
    const chars = () => (a as unknown as { historyChars(): number }).historyChars();

    for (let i = 0; i < 30; i++) {
      await turn(a, `domanda ${i} ${"z".repeat(2000)}`);
      // the budget survives the turn, plus the answer appended after `fitHistory` ran
      expect(chars()).toBeLessThanOrEqual(budget + 300);
    }
    // and it really was trimming each turn, not merely staying small on its own
    expect(a.history.length).toBeLessThan(30);
  });
});
