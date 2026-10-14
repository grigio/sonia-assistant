#!/usr/bin/env bun
/**
 * `bun run status` — one command for the whole picture (README §Development):
 *
 *   processes   `bun run stop --status`         what is running right now (pids, ports)
 *   endpoints   `bun run runtime-check`         are llama-server + ASR + TTS + turn + harness up?
 *   browser UI  `scripts/ui-test.sh` (opt-in)   the headless-Chromium suite, behind `--ui`
 *
 *   bun run status             # processes + endpoints (fast, read-only)
 *   bun run status --ui        # … plus the browser-UI suite (minutes, spawns a harness)
 *   bun run status --ui smoke  # … just these UI tests
 *   bun run status -h | --help
 *
 * The first two sections only *read*: they walk /proc, probe `/health` and print — nothing
 * is started or stopped. The UI suite is opt-in because it is a test run, not a report: it
 * spawns a throwaway harness on a spare port and a headless Chromium (minutes, and it
 * starts the audio.cpp servers on demand). Both existing commands keep working on their
 * own; this file runs them as they are (no logic copied here) so the three views can
 * never drift apart.
 *
 * Exit code 0 only when every needed endpoint answered *and* the UI suite (if asked for)
 * passed — so `bun run status && …` works as a gate.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const BUN = process.execPath; // the interpreter running us runs the scripts too

const tty = Boolean(process.stdout.isTTY);
const paint = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const title = (s: string) => paint(1, paint(34, s)); // bold blue, like `[stop]`/`[ui-test]`
const green = (s: string) => paint(32, s);
const red = (s: string) => paint(31, s);
const dim = (s: string) => paint(2, s);

const USAGE = `bun run status — what is running, and whether it answers (see scripts/status.ts).
  --ui [test…]  … also run the browser-UI suite (scripts/ui-test.sh, headless Chromium)
  -h, --help    this text`;

/** One stage: a section title plus the command printing under it. Its exit code. */
function run(heading: string, cmd: string[]): number {
  console.log(`\n${title(`── ${heading} ${"─".repeat(Math.max(0, 60 - heading.length))}`)}`);
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: ROOT, stdio: "inherit" });
  // stdio is inherited, so a stage that died of a signal/status null still counts as failed
  return r.status === 0 ? 0 : 1;
}

// ── arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let ui = false;
const uiTests: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--ui") ui = true;
  else if (a === "-h" || a === "--help") {
    console.log(USAGE);
    process.exit(0);
  } else if (a.startsWith("-")) {
    console.error(`${red("[status]")} unknown argument ${a} (try --help)`);
    process.exit(1);
  } else uiTests.push(a); // `bun run status --ui check smoke` → the suite's names
}

// ── the two read-only sections, always ───────────────────────────────────────
let failed = run("processes — what is running", [BUN, path.join(ROOT, "scripts/stop.ts"), "--status"]);
failed |= run("endpoints — do they answer", [BUN, path.join(ROOT, "scripts/runtime-check.ts")]);

// ── the browser-UI suite, on request ─────────────────────────────────────────
if (ui) {
  failed |= run("browser UI — scripts/ui-test.sh", ["bash", path.join(ROOT, "scripts/ui-test.sh"), ...uiTests]);
} else {
  console.log(dim(`\n(use --ui to also run the browser-UI suite: bun run status --ui [test…])`));
}

if (failed) console.log(`\n${red("status: something is down or failing")}`);
else console.log(`\n${green("status: all green")}`);
process.exit(failed);
