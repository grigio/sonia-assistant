/**
 * `bun run stop` — stop what `bun run start` started (the mirror of scripts/run.ts).
 * (Formerly the root-level ./stop.sh; same flags, same discovery rules, same output.)
 *
 *   bun run stop                harness web server (:8095) + its Chromium app window
 *   bun run stop --audio        … plus the three audio.cpp servers (asr/tts/turn)
 *   bun run stop --all          … plus llama-server (systemctl --user stop llama-server)
 *   bun run stop --port 8123    a harness listening on another port (leftover test instance)
 *   bun run stop --keep-window  stop the server but leave the Chromium window open
 *   bun run stop --grace 30     seconds to wait for a polite exit before SIGKILL
 *   bun run stop --dry-run      print what would be stopped, stop nothing
 *   bun run stop --status       print what is running (touches nothing)
 *
 * llama-server is external (README §Ports): only --all stops it.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isHarnessProcess, parsePidFile, parseSsPid } from "./proc";

const ROOT = path.resolve(import.meta.dir, "..");
const RUN = path.join(ROOT, "data", "run");

const c = {
  blue: "\x1b[1;34m",
  gray: "\x1b[1;90m",
  yellow: "\x1b[1;33m",
  red: "\x1b[1;31m",
  off: "\x1b[0m",
};
const info = (m: string) => console.log(`${c.blue}[stop]${c.off} ${m}`);
const note = (m: string) => console.log(`${c.gray}[stop]${c.off} ${m}`);
const warn = (m: string) => console.log(`${c.yellow}[stop]${c.off} ${m}`);
// The explicit `: (m: string) => never` annotation on the *binding* (not just the
// return type) is what lets TypeScript treat a call to it as terminating control flow:
// without it, `if (v === undefined) die(...)` does not narrow `v` away and every
// caller has to re-check. `scripts/**` is in the typecheck since v0.2.4.
const die: (m: string) => never = (m) => {
  console.error(`${c.red}[stop]${c.off} ${m}`);
  process.exit(1);
};

const USAGE = `bun run stop — stop what \`bun run start\` started (see scripts/stop.ts).
  --audio        … plus the three audio.cpp servers (asr/tts/turn)
  --all          … plus llama-server (systemd --user unit)
  --port 8123    a harness listening on another port (leftover test instance)
  --keep-window  stop the server but leave the Chromium window open
  --grace 30     seconds to wait for a polite exit before SIGKILL
  --dry-run      print what would be stopped, stop nothing
  --status, -s   print what is running (touches nothing)`;

// ── arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);

const port0 = Number(process.env.HARNESS_PORT ?? 8095);
if (!Number.isInteger(port0) || port0 < 1 || port0 > 65535)
  die(`HARNESS_PORT is not a port: ${port0}`);

let port = port0;
let grace = 10;
let doAudio = false;
let doAll = false;
let doStatus = false;
let keepWindow = false;
let dry = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  const next = (flag: string): string => {
    const v = argv[++i];
    if (v === undefined) die(`${flag} needs a value`);
    return v;
  };
  switch (a) {
    case "--audio":
      doAudio = true;
      break;
    case "--all":
      doAudio = true;
      doAll = true;
      break;
    case "--keep-window":
      keepWindow = true;
      break;
    case "--status":
    case "-s":
      doStatus = true;
      break;
    case "--dry-run":
    case "-n":
      dry = true;
      break;
    case "--port":
      port = Number(next("--port"));
      break;
    case "--grace":
      grace = Number(next("--grace"));
      break;
    case "-h":
    case "--help":
      console.log(USAGE);
      process.exit(0);
      break;
    default:
      die(`unknown argument ${a} (try --help)`);
  }
}
if (!Number.isInteger(port) || port < 1 || port > 65535) die(`--port needs a port`);
if (!Number.isFinite(grace) || grace < 0) die(`--grace needs seconds`);

// ── discovery (the /proc walk replaces pgrep/ss parsing where it helps) ──────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function allPids(): number[] {
  const out: number[] = [];
  for (const name of fs.readdirSync("/proc")) if (/^\d+$/.test(name)) out.push(Number(name));
  return out;
}

function cmdOf(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
}

function cwdOf(pid: number): string {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return "";
  }
}

/** basename of the running binary — `bun`/`node` for every harness instance. */
function exeOf(pid: number): string {
  try {
    return path.basename(fs.readlinkSync(`/proc/${pid}/exe`));
  } catch {
    return "";
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, not ours to signal
  }
}

/** pid of the listener on `p`, null if none — same `ss -tlnpH "sport = :$p"` as stop.sh. */
function pidOnPort(p: number): number | null {
  const r = spawnSync("ss", ["-tlnpH", `sport = :${p}`], { encoding: "utf8" });
  return parseSsPid(r.stdout ?? "");
}

/**
 * Is this pid one of *our* harness processes (never an unrelated process on the port)?
 * The rules live in proc.ts (pure, tested); the pid-file guards that need the *pid*
 * itself are here.
 */
function isHarness(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  return isHarnessProcess({ exe: exeOf(pid), cwd: cwdOf(pid), cmd: cmdOf(pid) }, ROOT, alive(pid));
}

function harnessPids(): number[] {
  const found = new Set<number>();
  const pf = path.join(RUN, "harness.pid");
  try {
    const pid = parsePidFile(fs.readFileSync(pf, "utf8"));
    if (pid !== null) found.add(pid);
  } catch {
    /* no pid file */
  }
  const onPort = pidOnPort(port);
  if (onPort !== null) found.add(onPort);
  for (const pid of allPids()) if (/cli\.ts --web/.test(cmdOf(pid))) found.add(pid);
  return [...found].filter(isHarness).sort((a, b) => a - b);
}

const CHROMIUM_STOP = `user-data-dir=${RUN}/chromium-profile`; // exact flag the app window gets
const CHROMIUM_ANY = "chromium-profile"; // looser pattern, for --status (as stop.sh had it)

function chromiumPids(pattern: string): number[] {
  return allPids()
    .filter((pid) => cmdOf(pid).includes(pattern))
    .sort((a, b) => a - b);
}

// ── stop one pid: graceful TERM → wait grace → KILL ──────────────────────────
async function stopPid(name: string, pid: number): Promise<void> {
  if (dry) {
    info(`would stop ${name} (pid ${pid}, ${cmdOf(pid).slice(0, 60)})`);
    return;
  }
  info(`stopping ${name} (pid ${pid})`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  for (let i = 0; i < grace * 2; i++) {
    await sleep(500);
    if (!alive(pid)) {
      info(`${name} stopped`);
      return;
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  info(`${name} did not exit in ${grace}s — killed`);
}

async function stopHarness(): Promise<void> {
  const pids = harnessPids();
  const held = pidOnPort(port);
  if (held !== null && !pids.includes(held)) {
    warn(
      `:${port} is held by pid ${held} (${cmdOf(held).slice(0, 70)}) — not one of ours, leaving it alone`,
    );
  }
  if (pids.length === 0) {
    note(`no harness running (port :${port} free)`);
    if (!dry) {
      try {
        fs.rmSync(path.join(RUN, "harness.pid"));
      } catch {
        /* already gone */
      }
    }
    return;
  }
  for (const pid of pids) await stopPid("harness", pid);
  if (!dry) {
    try {
      fs.rmSync(path.join(RUN, "harness.pid"));
    } catch {
      /* already gone */
    }
  }
}

async function stopChromium(): Promise<void> {
  if (keepWindow) {
    note("leaving the Chromium window open (--keep-window)");
    return;
  }
  const pids = chromiumPids(CHROMIUM_STOP);
  if (pids.length === 0) {
    note("no Chromium app window running");
    return;
  }
  info("stopping Chromium app window");
  if (dry) {
    info(`would stop Chromium app window (${pids.join(" ")})`);
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  for (let i = 0; i < grace * 2; i++) {
    await sleep(500);
    if (chromiumPids(CHROMIUM_STOP).length === 0) {
      info("Chromium stopped");
      return;
    }
  }
  for (const pid of chromiumPids(CHROMIUM_STOP)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  info(`Chromium did not exit in ${grace}s — killed`);
}

// ── --status: print what is running (touches nothing) ────────────────────────
async function status(): Promise<void> {
  const pad = (label: string) => label.padEnd(9);
  const p = pidOnPort(port);
  process.stdout.write(`${pad("harness")} :${port}  `);
  console.log(p !== null ? `up (pid ${p}, ${cwdOf(p)})` : "down");

  process.stdout.write(`${pad("chromium")} `);
  const ch = chromiumPids(CHROMIUM_ANY);
  console.log(ch.length > 0 ? `up (${ch[0]} pid)` : "down");

  if (fs.existsSync(path.join(ROOT, "scripts/start-audio-servers.sh"))) {
    spawnSync("bash", [path.join(ROOT, "scripts/start-audio-servers.sh"), "status"], {
      stdio: "inherit",
    });
  }

  process.stdout.write(`${pad("llama")} `);
  const base = (process.env.LLM_BASE_URL ?? "http://127.0.0.1:8080/v1").replace(/\/+$/, "");
  const up = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false);
  console.log(up ? "up" : "down");
}

if (doStatus) {
  await status();
  process.exit(0);
}

// ── stop ─────────────────────────────────────────────────────────────────────
await stopChromium();
await stopHarness();

if (doAudio) {
  if (dry) info("would stop the three audio.cpp servers (asr/tts/turn)");
  else
    spawnSync("bash", [path.join(ROOT, "scripts/start-audio-servers.sh"), "stop"], {
      stdio: "inherit",
    });
} else {
  note("audio.cpp servers left running (use --audio to stop them)");
}

if (doAll) {
  if (dry) {
    info("would stop llama-server (systemd --user unit)");
  } else {
    const unit = spawnSync("systemctl", ["--user", "cat", "llama-server.service"], {
      stdio: "ignore",
    });
    if (unit.status === 0) {
      info("stopping llama-server (systemd --user unit)");
      spawnSync("systemctl", ["--user", "stop", "llama-server.service"], { stdio: "inherit" });
    } else {
      warn("no llama-server.service under systemd --user — stop it yourself");
    }
  }
}

info("done");
