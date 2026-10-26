/**
 * The process half of the `run_command` tool: spawn, bounded output capture, timeout,
 * abort. Split out of `tools.ts` (which keeps the approval / epoch / UI-card logic) so
 * the risky part — kill the whole tree, never buffer unbounded output — is one small,
 * directly testable function.
 */

import { spawn } from "node:child_process";
import { CappedBuffer } from "./util";

/**
 * Cap on the captured stdout+stderr (the *tail* is what matters). The whole point: a
 * `yes`-style command used to grow `out` until the harness died, because the truncation
 * only happened after the process exited.
 */
export const MAX_OUTPUT = 256_000;

export type RunResult = {
  rc: number | null;
  output: string;
  timedOut: boolean;
};

/**
 * `bash -c command` in its own process group. Rejects (and kills the group) when
 * `signal` aborts — approval denied mid-flight, 🧹, or the response being cancelled —
 * and gives up after `timeoutS`.
 */
export async function runShell(
  command: string,
  opts: { timeoutS: number; signal?: AbortSignal; cwd?: string },
): Promise<RunResult> {
  const { timeoutS, signal } = opts;
  const proc = spawn("/bin/bash", ["-c", command], {
    cwd: opts.cwd ?? process.env.HOME ?? "/",
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group → kill the whole tree on timeout/abort
  });

  // chunk-array capture: a chatty command must not copy its whole (capped) output per chunk
  const out = new CappedBuffer(MAX_OUTPUT);
  // stdout and stderr are separate byte streams: each gets its own decoder so a
  // multi-byte character split across chunks survives (Italian accents in output).
  const outDec = new TextDecoder("utf-8");
  const errDec = new TextDecoder("utf-8");
  const grab = (dec: TextDecoder) => (d: Buffer) => out.add(dec.decode(d, { stream: true }));
  proc.stdout.on("data", grab(outDec));
  proc.stderr.on("data", grab(errDec));

  let timedOut = false;
  let aborted = false;
  const killGroup = () => {
    try {
      process.kill(-proc.pid!, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, timeoutS * 1000);
  const onAbort = () => {
    aborted = true;
    killGroup();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const rc = await new Promise<number | null>((resolve) => {
    proc.once("close", (code) => resolve(code));
    proc.once("error", () => resolve(null));
  }).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  });

  // flush a character whose remaining bytes never arrived before `close`
  out.add(outDec.decode());
  out.add(errDec.decode());
  if (aborted) throw new Error("command aborted");
  return { rc, output: out.text(), timedOut };
}
