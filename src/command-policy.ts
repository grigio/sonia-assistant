/**
 * The trust policy behind `run_command`: which command lines may run without approval.
 *
 * Pure functions and constants (split out of `tools.ts`, which keeps dispatch, the
 * approval flow and the UI cards — and out of `shell-runner.ts`, which does the actual
 * spawning). The rule set:
 *
 *   - plain read-only commands (`SAFE_COMMANDS`, `SAFE_SUBCOMMANDS`) run in "ask" mode
 *     unattended — and every one of them has a *verb/flag* check, not just a program name;
 *   - shell metacharacters (pipes, redirects, substitution, chaining) are never safe;
 *   - a *skill* line — every segment executing something inside SKILLS_DIR (the user's
 *     own code) or a validated read-only helper — is trusted, which is what lets a skill
 *     workflow run unattended;
 *   - sensitive paths (.ssh, keys, .env, /etc/shadow …) are **never touched unattended**:
 *     as `isSafeCommand` keeps them "not safe", the callers in `tools.ts` stop them at the
 *     approval prompt in "ask" mode and refuse them outright in "auto" (the mode where
 *     there is no one to ask). The path test expands `~`, globs and symlinks first — a
 *     string regex alone is bypassed by a `~/.ss*` glob and by `..`.
 *
 * The helpers that only read (`cat`, `grep`, …) are trusted *inside* a skill line, but
 * only with arguments that are neutral: `curl`/`wget` must fetch HTTP(S) into the skills
 * dir or /tmp, `mktemp` may only create under /tmp, and anything that can write or execute
 * (`env`, `awk`, `sed`, `sort -o`, `uniq out`, `mkdir`, `less`) is not a helper at all.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ShlexWord, shlexSplit, shlexSplitWords } from "./shlex";
import { expandTilde } from "./skills";

const HOME = process.env.HOME ?? os.homedir();
const TMP = "/tmp";

// ── read-only program tables ───────────────────────────────────────────────

/** Programs whose *default* use is read-only. Commands with an action verb live in
 *  `SAFE_SUBCOMMANDS` below (or in `SPECIAL_SAFE` when they need a flag check too). */
export const SAFE_COMMANDS = new Set([
  "uptime",
  "whoami",
  "uname",
  "df",
  "free",
  "lsblk",
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "ps",
  "ss",
  "sensors",
  "nproc",
  "lscpu",
  "id",
  "groups",
  "which",
  "file",
  "stat",
  "du",
  "findmnt",
  "echo",
  "cal",
  "lsusb",
  "lspci",
  "locale",
]);

/**
 * Programs whose *first action* decides whether they read or write. Kept exported for
 * callers/tests that only need the coarse table; `isSafeCommand` consults the stricter
 * `SUBCOMMAND_POLICY` below.
 */
export const SAFE_SUBCOMMANDS: Record<string, Set<string> | null> = {
  systemctl: new Set([
    "status",
    "is-active",
    "is-enabled",
    "is-failed",
    "list-units",
    "list-timers",
    "list-sockets",
    "show",
    "cat",
    "help",
  ]),
  journalctl: null, // any args *except* the maintenance verbs rejected below
  pacman: new Set(["-Q", "-Qi", "-Qs", "-Ql", "-Qe", "-Qu", "-Ss", "-Si"]),
  git: new Set(["status", "log", "diff", "branch", "show"]),
  date: null,
  hostname: null,
  hostnamectl: null,
  timedatectl: null,
  ip: null,
  nmcli: null,
  pactl: null,
  wpctl: null,
};

/** A flag or positional argument that must never appear on a read-only line. */
function hasFlag(args: string[], ...names: string[]): boolean {
  return args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
}

/** `date`: no args or a `+format` (plus the harmless display flags). `-s`, `--set` set it. */
function safeDate(args: string[]): boolean {
  if (hasFlag(args, "-s", "--set")) return false;
  // A bare positional word is a date string → `date 2026-01-01` sets the clock.
  return args.every((a) => a.startsWith("-") || a.startsWith("+"));
}

/** `hostname`: reading flags only; any bare word sets the hostname. */
function safeHostname(args: string[]): boolean {
  return args.every((a) => a.startsWith("-"));
}

/**
 * `hostnamectl` / `timedatectl`: only the status/list verbs. Anything else (`set-*`,
 * `set-time`, `set-timezone`, `set-ntp` …) changes the machine.
 */
function safeSystemdTool(args: string[], verbs: Set<string>): boolean {
  const bare = args.filter((a) => !a.startsWith("-"));
  if (!bare.length) return true;
  return bare.length === 1 && verbs.has(bare[0]!);
}

/** `ip`: only `addr` / `link show` / `route show`; every mutation verb is refused. */
function safeIp(args: string[]): boolean {
  const words = args.filter((a) => !a.startsWith("-"));
  const mutation = new Set([
    "set",
    "add",
    "del",
    "delete",
    "change",
    "replace",
    "append",
    "prepend",
    "flush",
    "up",
    "down",
    "save",
    "restore",
    "exec",
  ]);
  if (words.some((w) => mutation.has(w))) return false;
  if (!words.length) return true;
  const object = words[0]!;
  const allowed = new Set(["addr", "address", "a", "link", "l", "route", "r", "neigh"]);
  if (!allowed.has(object)) return false;
  if (object === "link" || object === "l") {
    // `ip link` / `ip link show` read; any other action would be a mutation and was
    // already rejected above.
    return (
      words.length <= 2 && (words[1] === undefined || words[1] === "show" || words[1] === "list")
    );
  }
  return true;
}

/** `nmcli`: the bare read-only spellings, with their optional flags (`-t`, `-f`, …). */
function safeNmcli(args: string[]): boolean {
  const words = args.filter((a) => !a.startsWith("-"));
  if (!words.length) return true;
  const forbidden = new Set([
    "up",
    "down",
    "modify",
    "delete",
    "add",
    "edit",
    "clone",
    "reload",
    "radio",
    "wifi",
    "on",
    "off",
    "connect",
  ]);
  if (words.some((w) => forbidden.has(w))) return false;
  const [first, second, third] = words;
  if (first === "general") return second === undefined || second === "status";
  if (first === "device") return second === undefined || second === "status";
  if (first === "connection") return second === undefined || second === "show";
  if (first === "show") return third === undefined;
  return false;
}

/** `pactl`: `list`, `info`, `get-*` only. `load-module`/`unload-module`/`set-*` mutate. */
function safePactl(args: string[]): boolean {
  const words = args.filter((a) => !a.startsWith("-"));
  if (!words.length) return true;
  const [first] = words;
  if (first === "list" || first === "info") return true;
  return Boolean(first?.startsWith("get-"));
}

/** `wpctl`: read-only queries only. */
function safeWpctl(args: string[]): boolean {
  const words = args.filter((a) => !a.startsWith("-"));
  if (!words.length) return true;
  const [first] = words;
  return (
    first === "status" ||
    first === "help" ||
    Boolean(first?.startsWith("get-")) ||
    first === "inspect"
  );
}

/** `journalctl`: read-only, except the maintenance verbs that rotate/vacuum the journal. */
function safeJournalctl(args: string[]): boolean {
  const bad = [
    "--vacuum-time",
    "--vacuum-size",
    "--vacuum-files",
    "--rotate",
    "--flush",
    "--sync",
    "--relinquish-var",
    "--setup-keys",
    "--update-catalog",
  ];
  return !hasFlag(args, ...bad);
}

/** `git`: only the read verbs; `branch`/`log`/`diff`/`show` also cannot write a file. */
function safeGit(args: string[]): boolean {
  const [verb, ...rest] = args;
  if (!verb) return false;
  if (!["status", "log", "diff", "branch", "show"].includes(verb)) return false;
  // `--output=<file>` and `-o <file>` are write primitives on an otherwise read command
  if (hasFlag(rest, "--output", "--output-directory")) return false;
  if (verb !== "branch") return true;
  // branch: listing flags, or a pattern only together with a listing flag
  const listing = rest.some((a) =>
    ["-a", "-r", "-v", "-vv", "-l", "--list", "--all", "--remotes", "--verbose"].includes(a),
  );
  const mutating = rest.some(
    (a) =>
      [
        "-d",
        "-D",
        "-m",
        "-M",
        "-c",
        "-C",
        "-f",
        "-u",
        "--delete",
        "--move",
        "--copy",
        "--force",
      ].includes(a) ||
      a.startsWith("--set-upstream-to") ||
      a.startsWith("--unset-upstream") ||
      a.startsWith("--edit-description"),
  );
  if (mutating) return false;
  const positional = rest.filter((a) => !a.startsWith("-"));
  return positional.length === 0 || listing;
}

/** The strict verb/flag check for the programs in `SAFE_SUBCOMMANDS`. */
function safeSubcommand(prog: string, args: string[]): boolean {
  switch (prog) {
    case "systemctl":
      return Boolean(
        args.length && SAFE_SUBCOMMANDS.systemctl!.has(args.find((a) => !a.startsWith("-"))!),
      );
    case "journalctl":
      return safeJournalctl(args);
    case "pacman":
      return Boolean(args.length && SAFE_SUBCOMMANDS.pacman!.has(args[0]!));
    case "git":
      return safeGit(args);
    case "date":
      return safeDate(args);
    case "hostname":
      return safeHostname(args);
    case "hostnamectl":
      return safeSystemdTool(args, new Set(["status", "show"]));
    case "timedatectl":
      return safeSystemdTool(args, new Set(["status", "show", "list-timezones"]));
    case "ip":
      return safeIp(args);
    case "nmcli":
      return safeNmcli(args);
    case "pactl":
      return safePactl(args);
    case "wpctl":
      return safeWpctl(args);
    default:
      return false;
  }
}

// ── sensitive paths ────────────────────────────────────────────────────────

const SHELL_META = /[;&|<>`$(){}\n\\*?!]/;
/** Pipes / redirection / substitution — never allowed, not even in a skill line. */
const INJECTION_META = /[|<>`$\n\r]/;

/**
 * The cheap string fallback. It is deliberately broad on *words* ("password", "token",
 * even inside prose) and is kept only as a second net: the boundary is
 * `pathIsSensitive()`, which sees the expanded, canonical path a shell would touch.
 */
const SENSITIVE_RAW =
  /\.ssh|\.gnupg|id_rsa|id_ed25519|\.pki|keyring|secret|token|passw|\.netrc|\.env\b|credentials|\/etc\/shadow|cookies|\.mozilla|chromium/i;

/** Directory names that, wherever they appear in a path, mark it as private. */
const SENSITIVE_SEGMENTS = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".pki",
  ".password-store",
  ".mozilla",
  ".thunderbird",
  ".config/gh",
]);

/** Exact basenames that are private wherever they live. */
const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".netrc",
  ".npmrc",
  ".git-credentials",
  ".authinfo",
  ".pgpass",
  ".my.cnf",
  "credentials",
  "cookies",
  "cookies.sqlite",
  "keyring",
  "login.keyring",
  "shadow",
  "gshadow",
  "sudoers",
]);

/** `id_rsa`, `id_ed25519.pub`, `id_ecdsa` … — a key, not the `id` command. */
const PRIVATE_KEY = /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/;

/** A token that names a *local* path (a URL or a flag is not one). */
function looksLikeLocalPath(tok: string): boolean {
  if (tok.startsWith("-") || tok.includes("://")) return false;
  return (
    tok.startsWith("/") ||
    tok.startsWith("./") ||
    tok.startsWith("../") ||
    tok.startsWith("~") ||
    tok.includes("/")
  );
}

/** Resolve a token the way the shell would for the paths we understand. */
function resolveTok(tok: string, cwd: string): string {
  if (tok.startsWith("~")) return expandTilde(tok);
  if (tok.startsWith("/")) return path.normalize(tok);
  return path.resolve(cwd, tok);
}

/** `realpath` when it exists; the normalised name otherwise (a missing target is still a
 *  path the shell may create/read relative to). Symlinks are followed on purpose. */
function canonical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function inside(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + path.sep);
}

/**
 * Expand the glob a word may carry (`~/.ss*`, `[a]`, `?`) the way bash would for the
 * simple cases this policy needs. A word with no glob is returned as-is; a word with a
 * glob and no match returns nothing, so a missed path can never be mistaken for a match.
 */
export function expandGlob(word: string, cwd = HOME): string[] {
  const abs = word.startsWith("~") ? expandTilde(word) : resolveTok(word, cwd);
  if (!/[*?[]/.test(abs)) return [abs];
  const start = path.isAbsolute(abs) ? path.parse(abs).root : cwd;
  const rel = path.isAbsolute(abs) ? abs.slice(start.length) : abs;
  let bases = [start];
  for (const part of rel.split(path.sep)) {
    if (!part) continue;
    const next: string[] = [];
    for (const base of bases) {
      if (!/[*?[]/.test(part)) {
        next.push(path.join(base, part));
        continue;
      }
      let names: string[] = [];
      try {
        names = fs.readdirSync(base);
      } catch {
        continue; // unreadable/unmatched directory: no expansion here
      }
      const re = globToRegExp(part);
      for (const name of names.sort()) if (re.test(name)) next.push(path.join(base, name));
    }
    bases = next;
    if (!bases.length) break;
  }
  // like the shell: a glob only stands for paths that exist. Without this filter,
  // `*/SKILL.md` would "match" every directory (and even regular files), and the
  // caller would then reject the whole line because the imaginary path is missing.
  return bases.filter((p) => fs.existsSync(p));
}

/** A tiny `*` / `?` / `[abc]` matcher for one path segment. */
function globToRegExp(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) re += "\\[";
      else {
        re += `[${pattern.slice(i + 1, end)}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`${re}$`);
}

function pathIsSensitive(p: string): boolean {
  const abs = canonical(p);
  const parts = abs.split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!;
    if (!seg) continue;
    if (SENSITIVE_SEGMENTS.has(seg)) return true;
    if (i > 0 && seg === "gh" && parts[i - 1] === ".config") return true;
  }
  const base = path.basename(abs);
  if (SENSITIVE_BASENAMES.has(base) || PRIVATE_KEY.test(base)) return true;
  if (abs === "/etc/shadow" || abs === "/etc/gshadow" || abs === "/etc/sudoers") return true;
  if (abs.startsWith("/etc/sudoers.d/")) return true;
  if (abs.startsWith("/proc/") && (base === "environ" || base === "mem" || base === "kcore"))
    return true;
  return false;
}

/** Every local path a command line may touch, after tilde + glob expansion. */
function commandPaths(command: string, cwd = HOME): string[] {
  let words: ShlexWord[];
  try {
    words = shlexSplitWords(command);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const { word } of words) {
    if (!word || word.startsWith("-")) continue;
    // `file:///etc/shadow` is a local read hidden in a URL: treat it as the path it is
    if (/^file:\/\//i.test(word)) {
      out.push(word.replace(/^file:\/\//i, ""));
      continue;
    }
    if (word.includes("://")) continue;
    if (!looksLikeLocalPath(word) && !word.includes("*") && !word.includes("?")) {
      // a bare word may still be a relative file name (`cat .env`, `cat id_rsa`)
      out.push(resolveTok(word, cwd));
      continue;
    }
    out.push(...expandGlob(word, cwd));
  }
  return out;
}

/**
 * The cheap word net. It is applied only to words that are *not* local paths: a path is
 * judged by `pathIsSensitive`, so a legitimate skill file called `token-notes.md` stays
 * usable while `echo password` and `grep TOKEN …` still get the broad treatment.
 */
function rawSensitive(command: string): boolean {
  let words: ShlexWord[];
  try {
    words = shlexSplitWords(command);
  } catch {
    return SENSITIVE_RAW.test(command);
  }
  return words.some(({ word }) => {
    if (!word || word.startsWith("-")) return false;
    if (looksLikeLocalPath(word) || /[*?[]/.test(word) || word.includes("://")) return false;
    return SENSITIVE_RAW.test(word);
  });
}

// ── skill lines ────────────────────────────────────────────────────────────

/** Interpreters: only "run this file under the skills dir" is trusted, never inline code. */
const INTERPRETERS = new Set([
  "bun",
  "node",
  "deno",
  "tsx",
  "ts-node",
  "python",
  "python3",
  "perl",
  "bash",
  "sh",
  "zsh",
  "fish",
]);
/** Flags that mean "the code is right here on the command line" → never auto-run. */
const INLINE_CODE_FLAGS = new Set([
  "-c",
  "-e",
  "--eval",
  "-p",
  "--print",
  "-m",
  "--module",
  "-r",
  "--require",
  "--import",
]);

/**
 * Read-only helpers a skill workflow may chain around its own script. Deliberately
 * *without* `env`, `awk`, `sed`, `sort`, `uniq`, `mkdir`, `less`, `curl`/`wget` (the
 * last two are validated separately): each of them can execute or write.
 */
const SKILL_HELPERS = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "tr",
  "wc",
  "base64",
  "realpath",
  "dirname",
  "basename",
  "sleep",
  "test",
  "printf",
  "echo",
]);

/** `curl`/`wget` may only fetch HTTP(S), and may only write inside the skills dir or /tmp. */
function safeFetch(prog: "curl" | "wget", args: string[], root: string, cwd: string): boolean {
  const allowWrite = (target: string): boolean => {
    const abs = canonical(resolveTok(target, cwd));
    return inside(root, abs) || inside(canonical(TMP), abs);
  };
  const urls: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-")) {
      urls.push(a);
      continue;
    }
    const takeValue = () => {
      const eq = a.indexOf("=");
      if (eq > 0) return a.slice(eq + 1);
      i++;
      return args[i] ?? "";
    };
    // flags that consume a value which is not a URL: headers, auth, timeouts, proxies …
    const valueFlags =
      prog === "curl"
        ? new Set([
            "-H",
            "--header",
            "-A",
            "--user-agent",
            "-e",
            "--referer",
            "-b",
            "--cookie",
            "-u",
            "--user",
            "-m",
            "--max-time",
            "--connect-timeout",
            "--retry",
            "--retry-delay",
            "--retry-max-time",
            "-x",
            "--proxy",
            "--resolve",
            "--cacert",
            "--capath",
            "--cert",
            "--key",
            "--interface",
            "--limit-rate",
            "--max-filesize",
            "--url",
            "-w",
            "--write-out",
            "--proto",
            "--proto-redir",
            "-r",
            "--range",
          ])
        : new Set([
            "-U",
            "--user-agent",
            "--header",
            "--referer",
            "--user",
            "--password",
            "-T",
            "--timeout",
            "--tries",
            "--wait",
            "--waitretry",
            "--limit-rate",
            "--progress",
            "--bind-address",
          ]);
    if (valueFlags.has(a)) {
      takeValue();
      continue;
    }
    if (prog === "curl") {
      if (["-K", "--config", "-F", "--form", "-T", "--upload-file"].includes(a)) return false;
      // cookie-jar / header dumps / traces write files: validate or refuse
      if (["-c", "--cookie-jar", "-D", "--dump-header"].includes(a)) {
        if (!allowWrite(takeValue())) return false;
        continue;
      }
      if (["--trace", "--trace-ascii", "--stderr", "--libcurl", "--remote-header-name"].includes(a))
        return false;
      if (["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode"].includes(a))
        return false;
      if (a.startsWith("--data=") || a.startsWith("--data-raw=") || a.startsWith("--data-binary="))
        return false;
      if (a === "-X" || a === "--request") {
        const m = takeValue().toUpperCase();
        if (m !== "GET" && m !== "HEAD") return false;
        continue;
      }
      if (a.startsWith("--request=")) {
        const m = a.slice("--request=".length).toUpperCase();
        if (m !== "GET" && m !== "HEAD") return false;
        continue;
      }
      if (a === "-o" || a === "--output") {
        if (!allowWrite(takeValue())) return false;
        continue;
      }
      if (a.startsWith("--output=")) {
        if (!allowWrite(a.slice("--output=".length))) return false;
        continue;
      }
      if (a === "-O" || a === "--remote-name" || a.startsWith("--output-dir")) return false;
      if (a === "--netrc" || a === "--netrc-file" || a === "-n") return false;
    } else {
      // wget
      if (["--post-data", "--post-file", "--body-data", "--body-file", "--method"].includes(a))
        return false;
      if (a.startsWith("--post-data=") || a.startsWith("--body-data=")) return false;
      if (a === "-O" || a === "--output-document") {
        if (!allowWrite(takeValue())) return false;
        continue;
      }
      if (a.startsWith("--output-document=")) {
        if (!allowWrite(a.slice("--output-document=".length))) return false;
        continue;
      }
      if (a === "-P" || a === "--directory-prefix") {
        if (!allowWrite(takeValue())) return false;
        continue;
      }
      if (a.startsWith("--directory-prefix=")) {
        if (!allowWrite(a.slice("--directory-prefix=".length))) return false;
      }
    }
  }
  if (!urls.length) return false; // a fetch with no URL is not a read
  return urls.every(
    (u) => /^https?:\/\//i.test(u) || /^https?:\/\//i.test(u.replace(/^["']|["']$/g, "")),
  );
}

/** `mktemp`: may only create under /tmp. */
function safeMktemp(args: string[], root: string, cwd: string): boolean {
  const write = (t: string): boolean => {
    const abs = canonical(resolveTok(t, cwd));
    return inside(canonical(TMP), abs) || inside(root, abs);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-p" || a === "--tmpdir") {
      if (args[i + 1] && !write(args[++i]!)) return false;
      continue;
    }
    if (a.startsWith("--tmpdir=")) {
      if (!write(a.slice("--tmpdir=".length))) return false;
      continue;
    }
    if (!a.startsWith("-") && !write(a)) return false;
  }
  return true;
}

/** A path argument that lives under the skills dir must exist and stay inside it. */
function skillPathsExist(args: string[], root: string, cwd: string): boolean {
  for (const a of args) {
    if (a.startsWith("-") || a.includes("://")) continue;
    if (!looksLikeLocalPath(a) && !a.includes("*") && !a.includes("?")) continue;
    const matches = expandGlob(a, cwd);
    if (!matches.length) return false; // the word names a skill path that does not exist
    for (const m of matches) {
      const abs = canonical(m);
      // a glob that matches anything outside the skills dir is not this line's business
      if (!inside(root, abs)) continue;
      if (!fs.existsSync(abs)) return false;
    }
  }
  return true;
}

function segmentTrusted(toks: string[], root: string, cwd: string): boolean {
  const prog = toks[0];
  if (!prog) return false;
  const base = path.basename(prog);
  const args = toks.slice(1);
  const own = looksLikeLocalPath(prog) && inside(root, canonical(resolveTok(prog, cwd)));
  if (own) {
    if (INTERPRETERS.has(base)) return false; // a file named `python` is not an interpreter
    if (!fs.existsSync(canonical(resolveTok(prog, cwd)))) return false;
    return true;
  }
  if (INTERPRETERS.has(base)) {
    if (args.some((a) => INLINE_CODE_FLAGS.has(a) || a.startsWith("--eval="))) return false;
    const script = args.find(
      (a) => looksLikeLocalPath(a) || a.endsWith(".py") || a.endsWith(".ts"),
    );
    if (!script) return false;
    const abs = canonical(resolveTok(script, cwd));
    return inside(root, abs) && fs.existsSync(abs);
  }
  if (base === "cd") return false; // handled by the caller (it changes the cwd)
  if (base === "curl" || base === "wget") {
    // safeFetch validates the URLs *and* every write target; the `-o` file does not
    // exist yet, so the generic "skill paths must exist" check cannot apply here.
    return safeFetch(base, args, root, cwd);
  }
  if (base === "mktemp") return safeMktemp(args, root, cwd);
  if (SKILL_HELPERS.has(base)) return skillPathsExist(args, root, cwd);
  return false;
}

/**
 * Does the command line name at least one path inside the skills directory?
 * (A URL is not a local path, so `read_url.ts "https://…"` still counts.)
 */
export function isSkillCommand(command: string, skillsDir?: string): boolean {
  if (!skillsDir) return false;
  const root = canonical(expandTilde(skillsDir).replace(/\/+$/, ""));
  if (!root) return false;
  let argv: string[];
  try {
    argv = shlexSplit(command);
  } catch {
    return false;
  }
  return argv.some((tok) => {
    if (!looksLikeLocalPath(tok) && !/[*?[]/.test(tok)) return false;
    // expand the globs a shell would (`~/.pi/agent/skills/*/run.ts`) before asking
    // whether any match lives inside the skills root
    return expandGlob(tok, HOME).some((p) => inside(root, canonical(p)));
  });
}

/**
 * A *skill* line: names a path under the skills directory and every segment of it
 * executes something sensible — the skill's own file, an interpreter pointed at it, or a
 * validated read-only helper. That is what lets `curl … -o /tmp/x.html && python3
 * <skills>/extract_ddg.py /tmp/x.html` run unattended (the user's own skills are trusted),
 * while `curl … && rm -rf ~`, `bash /tmp/evil.sh <skills>/y` and `python3 -c '…'` still
 * stop at the approval prompt. Pipes, redirection, substitution, `&` and `\r` are refused
 * outright, and so is a word that smuggles a separator inside it (`cat <skills>/x;rm -rf ~`)
 * — the shell honours that glue; the segment model below does not describe it.
 */
export function isTrustedSkillLine(command: string, skillsDir: string): boolean {
  if (INJECTION_META.test(command)) return false;
  let words: ShlexWord[];
  try {
    words = shlexSplitWords(command);
  } catch {
    return false;
  }
  const root = canonical(expandTilde(skillsDir).replace(/\/+$/, ""));
  if (!root) return false;
  const segs: string[][] = [[]];
  const cur = () => segs[segs.length - 1]!;
  for (const { word: tok, bare } of words) {
    // the separators the segment model knows: bare `&&` / `||` / `;`, plus one glued to
    // the end of a word (`cat file;` — the shell needs no space there either)
    if (tok === "&&" || tok === "||" || tok === ";") {
      if (!cur().length) return false; // `cmd && && …`
      segs.push([]);
      continue;
    }
    let word = tok;
    let glued: string | null = null;
    let shave = 0;
    if (word.endsWith("&&") && word.length > 2) {
      word = word.slice(0, -2);
      glued = "&&";
      shave = 2;
    } else if (word.endsWith("||") && word.length > 2) {
      word = word.slice(0, -2);
      glued = "||";
      shave = 2;
    } else if (word.endsWith(";") && word.length > 1) {
      word = word.slice(0, -1);
      glued = ";";
      shave = 1;
    }
    // any separator read by the shell OUTSIDE quotes is control flow this segment model
    // does not describe: refuse the word (`x;rm`, `a&&b`, a bare `&`). A *quoted* one is
    // inert — `cat "a;b.txt"` is one read, not two commands — so `bare` counts only
    // unquoted characters, and one glued separator may consume its own
    if (bare > shave) return false;
    cur().push(word);
    if (glued !== null) {
      if (!cur().length) return false; // unreachable: a glued sep implies a word
      segs.push([]);
    }
  }
  if (!cur().length) return false; // trailing separator
  // a `cd` may only move *into* the skills dir: it becomes the cwd for the relative
  // paths of the segments that follow (`cd <skill> && bun run scripts/x.ts`)
  let cwd = HOME;
  for (const seg of segs) {
    if (path.basename(seg[0]!) === "cd") {
      if (seg.length !== 2) return false;
      const next = canonical(resolveTok(seg[1]!, cwd));
      if (!inside(root, next)) return false;
      if (!fs.existsSync(next)) return false;
      cwd = next;
      continue;
    }
    if (!segmentTrusted(seg, root, cwd)) return false;
  }
  return true;
}

// ── classification ─────────────────────────────────────────────────────────

export function isSafeCommand(command: string, skillsDir?: string): boolean {
  // the cheap word net first (`grep TOKEN`, `echo password`); then the real path test
  if (rawSensitive(command)) return false;
  for (const p of commandPaths(command)) if (pathIsSensitive(p)) return false;
  // the user's own skills: trusted (see isTrustedSkillLine)
  if (skillsDir && isSkillCommand(command, skillsDir)) {
    return isTrustedSkillLine(command, skillsDir);
  }
  if (SHELL_META.test(command)) return false;
  let argv: string[];
  try {
    argv = shlexSplit(command);
  } catch {
    return false;
  }
  if (!argv.length) return false;
  const prog = path.basename(argv[0]!);
  const args = argv.slice(1);
  if (SAFE_COMMANDS.has(prog)) return true;
  if (prog in SAFE_SUBCOMMANDS) return safeSubcommand(prog, args);
  return false;
}

/**
 * Does the command line name something in the sensitive set (`.ssh`, keys, `.env`,
 * credentials, browser profiles …)? `isSafeCommand` already answers "no" for these —
 * the value of this function is telling a *caller that does not consult `safe`* (the
 * `CMD_MODE=auto` path in `tools.ts`, where nothing else would stop the call) that this
 * exact command is the one that must not run unattended.
 *
 * Path-aware: a `~/.ss*` glob is expanded and canonicalised before the match, so the glob
 * trick that used to read `~/.ssh/id_ed25519` unattended is caught here.
 */
export function isSensitiveCommand(command: string): boolean {
  if (rawSensitive(command)) return true;
  for (const p of commandPaths(command)) if (pathIsSensitive(p)) return true;
  return false;
}

/**
 * Privilege escalation — `sudo`, `doas`, `pkexec`, `su` — token-wise. The approval flow
 * asks for these even in `auto`, because nothing else in that mode stops a prompt
 * injection from turning a fetch into root (P0.4).
 */
export function isPrivilegedCommand(command: string): boolean {
  let words: ShlexWord[];
  try {
    words = shlexSplitWords(command);
  } catch {
    return false;
  }
  return words.some(({ word }) => {
    const base = path.basename(word);
    return base === "sudo" || base === "doas" || base === "pkexec" || base === "su";
  });
}

/**
 * Operations worth a confirmation even in `auto`: they destroy data and cannot be
 * undone. Targeted on purpose — this is an exception to the default, not a change to it.
 */
export function isDestructiveCommand(command: string): boolean {
  let argv: string[];
  try {
    argv = shlexSplit(command);
  } catch {
    return false;
  }
  if (!argv.length) return false;
  const prog = path.basename(argv[0]!);
  const args = argv.slice(1);
  const omitted = (a: string) => a.startsWith("-") && !a.startsWith("--");
  if (prog === "rm") {
    const recursive = args.some(
      (a) => (a.startsWith("-") && (a.includes("r") || a.includes("R"))) || a === "--recursive",
    );
    if (!recursive) return false;
    const targets = args.filter((a) => !a.startsWith("-"));
    if (!targets.length) return true; // `rm -rf` with no target is still a red flag
    return targets.some((t) => {
      const abs = canonical(resolveTok(t, HOME));
      return !inside(canonical(TMP), abs);
    });
  }
  if (prog === "dd") return args.some((a) => a.startsWith("of="));
  if (prog === "mkfs" || prog.startsWith("mkfs.") || prog === "wipefs" || prog === "shred")
    return true;
  if (prog === "git") {
    // `git clean -fdx`: the one git verb that deletes untracked work wholesale
    const clean = args[0] === "clean";
    const force = args.some(
      (a) => a === "-f" || a === "--force" || (omitted(a) && a.includes("f")),
    );
    return clean && force && args.some((a) => a === "-d" || a === "-x" || /^-[a-z]*[dx]/.test(a));
  }
  if (prog === "chmod" || prog === "chown" || prog === "chgrp") {
    const recursive = args.some(
      (a) => (a.startsWith("-") && (a.includes("R") || a.includes("r"))) || a === "--recursive",
    );
    if (!recursive) return false;
    // the first positional word is the mode (chmod) or owner (chown/chgrp); only the
    // paths after it are targets
    const targets = args.filter((a) => !a.startsWith("-")).slice(1);
    return targets.some((a) => {
      const abs = canonical(resolveTok(a, HOME));
      return abs === canonical(HOME) || abs === "/" || abs.startsWith(canonical(HOME) + path.sep);
    });
  }
  return false;
}
