#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
/**
 * `bun run fetch-and-compile-audio.cpp` — fetch a pinned audio.cpp **release** and
 * compile `audiocpp_server` from its source (the official prebuilt binaries are built
 * with `-march=native` on AVX-512 CI runners and SIGILL on CPUs without AVX-512 — see
 * the "Why compile" note in README.md; fetching source, not a release asset, is the point).
 *
 *   bun run fetch-and-compile-audio.cpp               clone/update `vendor/audio.cpp` to the verified tag and build it
 *   bun run fetch-and-compile-audio.cpp --tag v0.9.1  … pin another release (explicit, but unverified)
 *   bun run fetch-and-compile-audio.cpp --latest      … use the newest release (mutable: no commit pin)
 *   bun run fetch-and-compile-audio.cpp -h | --help
 *
 * What it does, in order:
 *   1. resolve the tag: PINNED_TAG by default (or `--tag`, or the newest release with `--latest`)
 *   2. clone `vendor/audio.cpp` at that tag, or `git fetch` + check it out when it exists
 *      (a dirty checkout is refused, nothing is stashed or discarded behind your back)
 *      — the pinned tag's commit is verified against PINNED_COMMIT, so a moved tag fails
 *   3. `cmake` configure + build the `audiocpp_server` target (incremental on re-runs)
 *   4. verify `vendor/audio.cpp/build/bin/audiocpp_server` and say how to start it
 *
 * The vendor directory is git-ignored: it is fetched on demand, never committed.
 *
 * Env:
 *   AUDIOCPP_VULKAN=ON|OFF   force the Vulkan backend instead of auto-detecting
 *                            (auto: ON when the Vulkan headers + `glslc` are installed)
 *   AUDIOCPP_SERVER=…        where `scripts/start-audio-servers.sh` looks for the binary
 *                            (defaults to the path this script builds)
 *
 * Needs: git, cmake, a C++ toolchain (Ninja when available), and network for step 1–2.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const REPO = "https://github.com/0xShug0/audio.cpp";
/** The release this repo is built and tested against, and the commit it must resolve to. */
const PINNED_TAG = "v0.9.2";
const PINNED_COMMIT = "0097d365a00b52a6991ad7618f0a04e8d2935e47";
const VENDOR = path.join(ROOT, "vendor", "audio.cpp");
const BUILD = path.join(VENDOR, "build");
const BIN = path.join(BUILD, "bin", "audiocpp_server");

const tty = Boolean(process.stdout.isTTY);
const paint = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => paint(32, s);
const red = (s: string) => paint(31, s);
const yellow = (s: string) => paint(33, s);
const dim = (s: string) => paint(2, s);

const info = (s: string) => console.log(`${green("[audio.cpp]")} ${s}`);
const warn = (s: string) => console.error(`${yellow("[audio.cpp]")} ${s}`);
function die(s: string): never {
  console.error(`${red("[audio.cpp]")} ${s}`);
  process.exit(1);
}

type Res = { ok: boolean; out: string };

/** Run a command: output inherited when `capture` is unset, captured when it is set. */
function run(args: string[], capture = false): Res {
  const r = spawnSync(args[0]!, args.slice(1), {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    cwd: ROOT,
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** `command -v name` without assuming a `which` binary exists. */
function onPath(name: string): boolean {
  return spawnSync("/bin/sh", ["-c", `command -v ${name} >/dev/null 2>&1`]).status === 0;
}

const human = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

/** `v0.9.1` / `0.9.1` → comparable numbers; anything unparseable sorts last. */
function tagKey(tag: string): number[] | null {
  const m = /^v?(\d+(?:\.\d+)*)/.exec(tag);
  return m ? m[1]!.split(".").map(Number) : null;
}
function newer(a: string, b: string): boolean {
  const ka = tagKey(a);
  const kb = tagKey(b);
  if (!ka || !kb) return false;
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** Newest release tag: GitHub API first, `git ls-remote` when the API is unreachable. */
async function latestTag(): Promise<string> {
  try {
    const r = await fetch("https://api.github.com/repos/0xShug0/audio.cpp/releases/latest", {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) {
      const tag = ((await r.json()) as { tag_name?: string }).tag_name;
      if (tag) return tag;
    }
    warn(`GitHub API answered HTTP ${r.status} — falling back to git ls-remote`);
  } catch (err) {
    warn(
      `GitHub API unreachable (${err instanceof Error ? err.message : err}) — falling back to git ls-remote`,
    );
  }

  const r = run(["git", "ls-remote", "--tags", "--refs", REPO], true);
  if (!r.ok) die(`could not list releases: ${r.out}`);
  const tags = r.out
    .split("\n")
    .map((l) => l.split("refs/tags/")[1])
    .filter((t): t is string => Boolean(t) && tagKey(t!) !== null);
  if (!tags.length) die("no tags found upstream");
  return tags.reduce((best, t) => (newer(t, best) ? t : best));
}

/** Clone `vendor/audio.cpp` at `tag`, or move an existing clean clone to it. */
function fetchSource(tag: string): void {
  if (!fs.existsSync(VENDOR)) {
    fs.mkdirSync(path.dirname(VENDOR), { recursive: true });
    info(`cloning ${REPO} @ ${tag} → ${path.relative(ROOT, VENDOR)} ${dim("(shallow)")}`);
    const r = run(["git", "clone", "--depth", "1", "--branch", tag, REPO, VENDOR]);
    if (!r.ok) die(`clone failed — is "${tag}" a real tag? (${r.out})`);
    verifyPinned(tag);
    return;
  }
  if (!fs.existsSync(path.join(VENDOR, ".git")))
    die(`${path.relative(ROOT, VENDOR)} exists but is not a git clone — remove it and re-run`);

  const head = run(["git", "-C", VENDOR, "rev-parse", "HEAD"], true).out.trim();
  // fetch exactly this tag (works for shallow clones too); offline + already local → continue
  const f = run(
    ["git", "-C", VENDOR, "fetch", "--force", "origin", `refs/tags/${tag}:refs/tags/${tag}`],
    true,
  );
  if (!f.ok) {
    if (run(["git", "-C", VENDOR, "rev-parse", "--verify", `refs/tags/${tag}`], true).ok)
      warn(`git fetch failed (${f.out}) — the tag is local already, continuing offline`);
    else die(`could not fetch ${tag}: ${f.out}`);
  }

  const want = run(["git", "-C", VENDOR, "rev-parse", `${tag}^{commit}`], true).out.trim();
  if (head === want) {
    info(`source already at ${green(tag)}`);
    verifyPinned(tag);
    return;
  }

  const dirty = run(["git", "-C", VENDOR, "status", "--porcelain"], true).out;
  if (dirty)
    die(
      `${path.relative(ROOT, VENDOR)} has local changes — commit/stash/clean them first:\n` +
        dirty
          .split("\n")
          .slice(0, 5)
          .map((l) => `    ${l}`)
          .join("\n"),
    );

  info(`moving ${path.relative(ROOT, VENDOR)} ${dim(`(${head.slice(0, 8)} → ${tag})`)}`);
  const c = run(["git", "-C", VENDOR, "checkout", "--force", tag], true);
  if (!c.ok) die(`checkout ${tag} failed: ${c.out}`);
  const now = run(["git", "-C", VENDOR, "describe", "--tags", "--exact-match"], true).out.trim();
  info(`source at ${green(now || tag)}`);
  verifyPinned(tag);
}

/**
 * A tag name is not immutable: when it is the one this repo ships against, its commit is
 * what gets verified. A moved upstream tag is a supply-chain event — refuse to build it.
 */
function verifyPinned(tag: string): void {
  if (tag !== PINNED_TAG) {
    warn(`tag ${tag} is not the verified release (${PINNED_TAG}) — no commit check`);
    return;
  }
  const head = run(["git", "-C", VENDOR, "rev-parse", "HEAD"], true).out.trim();
  if (head !== PINNED_COMMIT)
    die(
      `${PINNED_TAG} resolves to ${head.slice(0, 8)} but ${PINNED_COMMIT.slice(0, 8)} was verified — ` +
        `the upstream tag moved; nothing was built`,
    );
  info(`commit ${dim(head.slice(0, 8))} matches the pinned release`);
}

/** Vulkan: honor AUDIOCPP_VULKAN, else auto-detect headers + `glslc`. */
function vulkanWanted(): boolean {
  const forced = process.env.AUDIOCPP_VULKAN?.trim().toUpperCase();
  if (forced === "ON") return true;
  if (forced === "OFF") return false;
  const headers =
    fs.existsSync("/usr/include/vulkan/vulkan.h") ||
    spawnSync("pkg-config", ["--exists", "vulkan"]).status === 0;
  const glslc = onPath("glslc");
  if (headers && glslc) return true;
  warn(
    `Vulkan toolchain not found (${!headers ? "no vulkan headers" : ""}${!headers && !glslc ? " and " : ""}${!glslc ? "no glslc" : ""}) → building CPU-only` +
      `\n  ${dim("…set AUDIOCPP_VULKAN=ON to insist, and run with ASR_BACKEND=cpu (no iGPU offload)")}`,
  );
  return false;
}

/** Configure (only when needed) + build `audiocpp_server`. Returns elapsed ms. */
function build(vulkan: boolean): number {
  const t0 = Date.now();
  const fresh = !fs.existsSync(path.join(BUILD, "CMakeCache.txt"));
  const cmakeArgs = ["-S", VENDOR, "-B", BUILD];
  if (fresh && onPath("ninja")) cmakeArgs.push("-G", "Ninja"); // an existing cache keeps its generator
  cmakeArgs.push("-DCMAKE_BUILD_TYPE=Release", `-DENGINE_ENABLE_VULKAN=${vulkan ? "ON" : "OFF"}`);

  info(`configuring ${dim(`(cmake ${cmakeArgs.join(" ")})`)}`);
  if (!run(["cmake", ...cmakeArgs]).ok) die("cmake configure failed");
  info(`building audiocpp_server ${dim("(incremental on re-runs)")}`);
  if (
    !run([
      "cmake",
      "--build",
      BUILD,
      "--target",
      "audiocpp_server",
      "--parallel",
      String(os_cpus()),
    ]).ok
  )
    die("build failed — see the compiler output above");
  return Date.now() - t0;
}

function os_cpus(): number {
  const r = run(["nproc"], true);
  const n = Number(r.out.trim());
  return Number.isFinite(n) && n > 0 ? n : 4;
}

function usage(): void {
  const src = fs.readFileSync(import.meta.path, "utf8");
  const doc = /\/\*\*([\s\S]*?)\*\//.exec(src)?.[1] ?? "";
  console.log(
    doc
      .split("\n")
      .map((l) => l.replace(/^\s*\* ?/, ""))
      .join("\n")
      .trim(),
  );
}

async function main(): Promise<number> {
  let tag: string | undefined;
  let latest = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-h" || a === "--help") {
      usage();
      return 0;
    } else if (a === "--latest") {
      latest = true;
    } else if (a === "--tag") {
      tag = args[++i];
      if (!tag || tag.startsWith("-")) {
        console.error("--tag needs a value (e.g. --tag v0.9.2)");
        return 2;
      }
    } else if (a.startsWith("--tag=")) {
      tag = a.slice("--tag=".length);
    } else {
      console.error(`unknown option: ${a} (try --help)`);
      return 2;
    }
  }
  if (tag && latest) {
    console.error("--tag and --latest are mutually exclusive");
    return 2;
  }

  const t0 = Date.now();
  if (latest) {
    tag = await latestTag();
    warn(`--latest: tracking a mutable release (${tag}) — no commit pin`);
  } else {
    tag ??= PINNED_TAG;
  }
  info(`release: ${green(tag)}`);
  fetchSource(tag);

  const elapsed = build(vulkanWanted());
  if (!fs.existsSync(BIN)) die(`build reported success but ${path.relative(ROOT, BIN)} is missing`);
  fs.chmodSync(BIN, 0o755);

  const size = fs.statSync(BIN).size;
  info(
    `${green("done")} ${path.relative(ROOT, BIN)} ${dim(`(${(size / 1024 / 1024).toFixed(0)} MiB, build ${human(elapsed)}, total ${human(Date.now() - t0)})`)}`,
  );
  info(
    dim(
      `scripts/start-audio-servers.sh picks it up automatically — override with AUDIOCPP_SERVER=${path.relative(ROOT, BIN)}`,
    ),
  );
  return 0;
}

process.exit(await main());
