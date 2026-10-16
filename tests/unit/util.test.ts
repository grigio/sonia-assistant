/**
 * `src/util.ts` — the primitives everything else leans on: cancellation, timeouts, the
 * bounded string accumulator (the one that keeps a `yes`-style command from eating the
 * heap) and the crash-safe JSON write.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  abortError,
  appendCapped,
  concatBytes,
  sleep,
  timeoutSignal,
  which,
  writeJsonAtomic,
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
    const old = process.env.PATH;
    process.env.PATH = "/nonexistent:/alsonot";
    try {
      expect(which("sh")).toBeNull();
    } finally {
      process.env.PATH = old;
    }
  });
});

describe("writeJsonAtomic", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-util-"));

  test("writes the JSON a later read parses back — pretty, store files are for humans too", () => {
    const file = path.join(dir, "notes.json");
    writeJsonAtomic(file, [{ text: "una nota" }, 2], 1);
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual([{ text: "una nota" }, 2]);
    // indent 1 = one space per level: a *string* indent ("1") would repeat per depth
    // and produce junk that no longer parses (`[\n1{`) — the number is load-bearing
    expect(fs.readFileSync(file, "utf-8")).toContain("[\n {");
  });

  test("rewrites replace the target outright and leave no `.tmp` litter", () => {
    const file = path.join(dir, "skills.json");
    writeJsonAtomic(file, ["a"], 1);
    writeJsonAtomic(file, ["a", "b"], 1);
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual(["a", "b"]);
    expect(fs.readdirSync(dir).sort()).toEqual(["notes.json", "skills.json"]);
  });

  test("a torn previous write does not break the next save (it reserves the name)", () => {
    const file = path.join(dir, "torn.json");
    fs.writeFileSync(file, '{"n": 1'); // a crashed process left this
    fs.writeFileSync(path.join(dir, "torn.json.tmp"), "x"); // the tmp slot is free game
    writeJsonAtomic(file, { n: 2 }, 1); // the next save replaces both wholesale
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ n: 2 });
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });
});
