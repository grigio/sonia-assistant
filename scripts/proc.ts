/**
 * Pure pieces of scripts/stop.ts process discovery — pulled out so the parsing rules
 * (a pid file, an `ss -tlnpH` line, "does this proc count as the harness?") are testable
 * without spawning anything (tests/unit/proc.test.ts). stop.ts keeps the impure side:
 * walking /proc, running `ss`.
 *
 * The harness test is deliberately paranoid: any user agent whose *command line* merely
 * quotes the checkout path and `cli.ts` (a grep, a `bun test` invocation, a paste into a
 * chat) would otherwise match the walk and get SIGTERMed. Two guards kill that:
 * the cwd/cmd allow-list below and the interpreter check (`exe` must be bun/node).
 */

/** A pid file: one positive integer, or nothing. `""`/junk/negative → null. */
export function parsePidFile(text: string): number | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The single pid=`…` field of one `ss -tlnpH` run, or none — `spawnSync` won a race? */
export function parseSsPid(output: string): number | null {
  const m = output.match(/pid=(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Could `{exe, cwd, cmd}` be one of *our* harness processes (never e.g. an unrelated
 * process that merely holds the port)? `root` is the checkout, `alive` whether the pid
 * exists at all (EPERM counts: it exists, it is just not ours to signal). The pid-file
 * guards (≤ 1, == self, integer) live with the *pid*, in stop.ts — here everything is
 * known from /proc only: cwd/cmdline say "it is a cli.ts of this checkout", the exe
 * check says "and it really *is* the interpreter running it".
 */
export function isHarnessProcess(
  proc: { exe: string; cwd: string; cmd: string },
  root: string,
  alive: boolean,
): boolean {
  if (!alive) return false;
  if (proc.exe !== "bun" && proc.exe !== "node") return false;
  return (
    (proc.cwd === root || proc.cwd.startsWith(`${root}/`) || proc.cmd.includes(root)) &&
    proc.cmd.includes("cli.ts")
  );
}
