/**
 * `bun run start` — start the audio.cpp servers (if needed) and the full-duplex harness.
 * (Formerly the root-level ./run.sh; same steps, same arguments, same exit codes.)
 * The LLM is the already-running llama-server on :8080 (Qwen3.5-4B-MTP-Q4_K_M).
 *
 *   bun run start                 web UI served on http://127.0.0.1:8095, no Chromium
 *   bun run webui                 same, but opens the embedded Chromium UI (mic + speaker + AEC)
 *                                 — if a harness is already listening (a `bun run start` in
 *                                 another terminal) it is reused, no second one is started
 *   bun run start --browser       same as `bun run webui`
 *   bun run gtk4                  the native GTK4 client — backends must already be running
 *                                 (`bun run start` in another terminal)
 *   bun run start --host 0.0.0.0  pass any cli.ts flag straight through
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

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config";
import { installCrashGuards } from "../src/log";

const ROOT = path.resolve(import.meta.dir, "..");
process.chdir(ROOT);
installCrashGuards(); // the wrapper dying on a stray rejection would strand the child

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
// `bun run webui` (or an explicit --browser) is the only way to get Chromium; plain
// `bun run start` serves the web UI but leaves the browser to you.
const withBrowser = argv.includes("--browser") || process.env.SONIA_OPEN_BROWSER === "1";
const rest = argv.filter((a) => a !== "--browser");
const flag = (name: string, fallback: string) => {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] ? rest[i + 1]! : fallback;
};

/** Is something already listening there? (the harness has no health route to ask) */
function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = net.connect({ host, port });
    s.once("connect", () => s.end(() => res(true)));
    s.once("error", () => res(false));
    setTimeout(() => s.destroy(), 2000).unref();
  });
}

const cliArgs: string[] =
  argv[0] === "--cli"
    ? argv.slice(1)
    : argv.includes("--text") || argv.includes("--input-wav")
      ? argv
      : ["--web", ...(withBrowser ? [] : ["--no-browser"]), ...rest];

// ── 3b. an already-running harness owns the port ─────────────────────────────
// `bun run webui` is meant to be run *next to* `bun run start`: reuse that harness
// and just put the Chromium window on it, instead of dying on EADDRINUSE. The port is
// probed first; if the child still loses the race, its EADDRINUSE lands us here too.
const browserWeb = withBrowser && cliArgs[0] === "--web" && !cliArgs.includes("--no-browser");
const host = flag("--host", "127.0.0.1");
const port = Number(flag("--port", "8095"));

/** Attach the Chromium window to the harness already serving `url`, then idle. */
async function reuseHarness(): Promise<never> {
  const hostForUrl = net.isIP(host) === 6 ? `[${host}]` : host;
  const url = `http://${hostForUrl}:${port}/`;
  console.log(`\u267b\ufe0f  reusing the harness already on ${url} \u2014 opening Chromium only`);
  const { launchChromium } = await import("../src/web");
  launchChromium(url);
  // the window is the whole job: hold the script open until Ctrl+C
  await new Promise<void>((res) => {
    process.on("SIGINT", res);
    process.on("SIGTERM", res);
  });
  process.exit(0);
}

if (browserWeb && (await portOpen(host, port))) await reuseHarness();

// stderr is piped (and echoed straight through) only so that an EADDRINUSE can be
// recognised and turned into the reuse path instead of a fatal error.
let tail = "";
const child = spawn(process.execPath, ["run", "src/cli.ts", ...cliArgs], {
  cwd: ROOT,
  stdio: ["inherit", "inherit", "pipe"],
});
child.stderr?.on("data", (b: Buffer) => {
  tail += b.toString();
  if (tail.length > 8192) tail = tail.slice(-8192);
  process.stderr.write(b);
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
// lost the race for the port between the probe and the listen: something else owns it,
// and attaching a window to that harness is exactly what `bun run webui` is for.
if (browserWeb && code === 1 && tail.includes("EADDRINUSE")) await reuseHarness();

// a startup failure (EADDRINUSE, warmup, LLM/TTS down) must not look like a success:
// scripts/run.ts and any caller see a non-zero exit code. A child that dies from a signal
// reports 128+N, the same the shell used to return after `exec bun run src/cli.ts`.
process.exit(signal ? 128 + (os.constants.signals[signal] ?? 1) : (code ?? 1));
