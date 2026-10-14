/**
 * `src/util.ts` — the primitives everything else leans on: cancellation, timeouts and
 * the bounded string accumulator (the one that keeps a `yes`-style command from eating
 * the heap).
 */
import { describe, expect, test } from "bun:test";
import { sleep } from "../../src/util";
import {
  abortError,
  appendCapped,
  concatBytes,
  timeoutSignal,
  which,
} from "../../src/util";

describe("abortError / sleep", () => {
  test("the rejection is recognisable as an abort (isAbortError checks the name)", () => {
    const e = abortError();
    expect(e.name).toBe("AbortError");
    expect(e).toBeInstanceOf(Error);
  });

  test("sleep waits roughly the asked time", async () => {
    const t0 = Date.now();
    await sleep(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });
});

describe("concatBytes", () => {
  test("concatenates in order, including empty chunks", () => {
    const out = concatBytes([new Uint8Array([1, 2]), new Uint8Array(0), new Uint8Array([3])]);
    expect([...out]).toEqual([1, 2, 3]);
  });

  test("an empty list is an empty buffer, not a throw", () => {
    expect(concatBytes([]).length).toBe(0);
  });
});

describe("appendCapped", () => {
  test("below the cap the text passes through untouched", () => {
    expect(appendCapped("abc", "def", 100)).toBe("abcdef");
    expect(appendCapped("", "abc", 3)).toBe("abc");
  });

  test("above the cap the TAIL is kept — exactly `max` chars", () => {
    expect(appendCapped("0123456789", "abcde", 6)).toBe("9abcde");
    expect(appendCapped("", "x".repeat(10), 4)).toBe("xxxx");
  });

  test("one huge chunk alone is trimmed to the cap", () => {
    expect(appendCapped("", "abcdefghij", 4)).toBe("ghij");
  });
});

describe("timeoutSignal", () => {
  test("fires after `ms` when nothing else aborts it", async () => {
    const s = timeoutSignal(20);
    await new Promise<void>((res) => {
      s.addEventListener("abort", () => res(), { once: true });
    });
    expect(s.aborted).toBe(true);
  });

  test("a parent signal aborts it immediately, before the timeout", async () => {
    const parent = new AbortController();
    const s = timeoutSignal(60_000, parent.signal);
    parent.abort();
    expect(s.aborted).toBe(true);
  });

  test("undefined parents are ignored (the callers all pass optional signals)", async () => {
    const s = timeoutSignal(60_000, undefined, null);
    expect(s.aborted).toBe(false);
  });

  test("it never fires on its own within the window", async () => {
    const s = timeoutSignal(60_000);
    await sleep(30);
    expect(s.aborted).toBe(false);
  });
});

describe("which", () => {
  test("finds a binary that is in PATH", () => {
    expect(which("sh")).toContain("/sh");
    expect(which("definitely-not-a-program-xyz")).toBeNull();
  });

  test("a PATH full of holes does not throw", () => {
    const old = process.env["PATH"];
    process.env["PATH"] = "/nonexistent:/alsonot";
    try {
      expect(which("sh")).toBeNull();
    } finally {
      process.env["PATH"] = old;
    }
  });
});
