/**
 * `bun run start` — start the audio.cpp servers (if needed) and the full-duplex harness.
 * (Formerly the root-level ./run.sh; same steps, same arguments, same exit codes.)
 * The LLM is the already-running llama-server on :8080 (Qwen3.5-4B-MTP-Q4_K_M).
 *
 *   bun run start                 browser UI: opens Chromium (mic + speaker + AEC) once ready
 *   bun run start --no-browser    same, but just print the URL (http://127.0.0.1:8095)
 *   bun run start --cli           terminal mode through the default PipeWire mic/speaker
 *   bun run start --text          type instead of speaking
 *   bun run start --input-wav 1:q.wav --no-speaker --output-wav out.wav   (offline test)
 *   bun run stop                  stop what this script started (scripts/stop.ts)
 *
 * Prereqs: llama-server on :8080 (LLM leg) and audio.cpp built at vendor/audio.cpp
 * (see scripts/start-audio-servers.sh for the cmake build command).
 *
 * `.env` needs no parsing here: Bun itself exports every key of it into `process.env`
 * when it starts this file (a shell variable already set still wins), and every child
 * we spawn inherits that environment — the hand-rolled reader run.sh had is obsolete.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Config } from "../src/config";

const ROOT = path.resolve(import.meta.dir, "..");
process.chdir(ROOT);

const cfg = Config.fromEnv();

// ── 1. the LLM leg ───────────────────────────────────────────────────────────
// llama-server is needed by the API leg, and by the pi leg too when pi's model is
// served by it (the default llamacpp/Qwen3.5-…): only a non-local PI_MODEL makes
// the check pointless.
const needLlama = !cfg.llmViaPi || cfg.piModel.startsWith("llamacpp/");
if (needLlama) {
  // `${LLM_BASE_URL%/v1}/health` as run.sh did it: strip a trailing /v1, ask /health.
  const base = cfg.llmBaseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const up = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!up) {
    console.error(
      `llama-server not reachable at ${cfg.llmBaseUrl} — start it first (e.g. systemctl --user start llama-server)`,
    );
    process.exit(1);
  }
}

// ── 2. the audio.cpp servers (idempotent: already-running ones are left alone) ──
{
  const r = spawnSync("bash", [path.join(ROOT, "scripts/start-audio-servers.sh"), "start"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// ── 3. the harness ───────────────────────────────────────────────────────────
// Which mode: `--cli` first and foremost, then the offline-WAV flags, else the browser.
const argv = process.argv.slice(2);
const cliArgs: string[] =
  argv[0] === "--cli"
    ? argv.slice(1)
    : argv.includes("--text") || argv.includes("--input-wav")
      ? argv
      : ["--web", ...argv];

const child = spawn(process.execPath, ["run", "src/cli.ts", ...cliArgs], {
  cwd: ROOT,
  stdio: "inherit",
});

// pid file for `bun run stop` — the pid that actually listens on :8095, not ours.
fs.mkdirSync(path.join(ROOT, "data/run"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "data/run/harness.pid"), `${child.pid}\n`);

// a Ctrl+C in the terminal reaches both of us (same process group); pass it on anyway
// for the case where only this wrapper is signalled (systemd, `kill <pid>`).
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(sig);
  });
}

const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
  child.once("close", (c, s) => res([c, s]));
});
// a startup failure (EADDRINUSE, warmup, LLM/TTS down) must not look like a success:
// scripts/run.ts and any caller see a non-zero exit code. A child that dies from a signal
// reports 128+N, the same the shell used to return after `exec bun run src/cli.ts`.
process.exit(signal ? 128 + (os.constants.signals[signal] ?? 1) : (code ?? 1));
