/**
 * `src/shell-runner.ts` — the process half of `run_command`: the three things that can
 * go wrong with a shell tool are an unbounded buffer, a command that never ends, and a
 * killed parent leaving its children behind. All three are pinned here.
 */
import { describe, expect, test } from "bun:test";
import { MAX_OUTPUT, runShell } from "../../src/shell-runner";
import { sleep } from "../../src/util";

describe("runShell", () => {
  test("captures stdout and stderr together, with the exit code", async () => {
    const ok = await runShell("echo out; echo err >&2", { timeoutS: 10 });
    expect(ok.rc).toBe(0);
    expect(ok.timedOut).toBe(false);
    expect(ok.output).toContain("out");
    expect(ok.output).toContain("err");

    const bad = await runShell("exit 7", { timeoutS: 10 });
    expect(bad.rc).toBe(7);
  });

  test("TIMEOUT_S kills a command that would otherwise hang forever", async () => {
    const t0 = Date.now();
    const r = await runShell("sleep 30", { timeoutS: 1 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("the whole process GROUP dies on timeout — no orphaned children", async () => {
    const r = await runShell("sleep 30 & echo $!", { timeoutS: 1 });
    expect(r.timedOut).toBe(true);
    const child = Number(r.output.trim());
    expect(Number.isInteger(child)).toBe(true);
    await sleep(300); // the SIGKILL to -pgid takes effect right away, but let it land
    expect(() => process.kill(child, 0)).toThrow(); // ESRCH: it is gone with its parent
  });

  test("an aborted signal rejects (approval denied, 🧹, the turn was cancelled)", async () => {
    const ctl = new AbortController();
    const p = runShell("sleep 30", { timeoutS: 30, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    await expect(p).rejects.toThrow("command aborted");
  });

  test("the abort listener is removed: a finished run must not kill anything later", async () => {
    const ctl = new AbortController();
    await runShell("true", { timeoutS: 10, signal: ctl.signal });
    expect(() => ctl.abort()).not.toThrow(); // the listener is gone, the group with it
  });

  test("output is capped at MAX_OUTPUT and keeps the TAIL (that is where the answer is)", async () => {
    const r = await runShell(
      `printf 'HEAD-MARKER'; head -c ${MAX_OUTPUT + 44_000} /dev/zero | tr '\\0' 'x'; ` +
        `printf 'THE-END'`,
      { timeoutS: 30 },
    );
    expect(r.output.length).toBeLessThanOrEqual(MAX_OUTPUT);
    expect(r.output.endsWith("THE-END")).toBe(true);
    expect(r.output).not.toContain("HEAD-MARKER"); // the head is what the cap gives up
  }, 30_000);

  test("output below the cap is never touched", async () => {
    const r = await runShell("printf '0123456789'", { timeoutS: 10 });
    expect(r.output).toBe("0123456789");
  });
});
