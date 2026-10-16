/**
 * The trust policy behind `run_command`: which command lines may run without approval.
 *
 * Pure functions and constants (split out of `tools.ts`, which keeps dispatch, the
 * approval flow and the UI cards — and out of `shell-runner.ts`, which does the actual
 * spawning). The rule set:
 *
 *   - plain read-only commands (`SAFE_COMMANDS`) run in "ask" mode unattended;
 *   - shell metacharacters (pipes, redirects, substitution, chaining) are never safe;
 *   - a *skill* line — every segment executing something inside SKILLS_DIR (the user's
 *     own code) — is trusted, which is what lets a skill workflow run unattended;
 *   - sensitive paths (.ssh, keys, .env, /etc/shadow …) are **never touched unattended**:
 *     as `isSafeCommand` keeps them "not safe", the callers in `tools.ts` stop them at the
 *     approval prompt in "ask" mode and refuse them outright in "auto" (the mode where
 *     there is no one to ask). This module only classifies — `isSensitiveCommand` exists
 *     so the refusal half has something to consult.
 */

import path from "node:path";
import { type ShlexWord, shlexSplit, shlexSplitWords } from "./shlex";
import { expandTilde } from "./skills";

// Commands that only read state. In "ask" mode they run without confirmation when the
// command line has no shell metacharacters (no pipes, redirects, chaining, substitution).
export const SAFE_COMMANDS = new Set([
  "date",
  "uptime",
  "whoami",
  "hostname",
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
  "ip",
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
  "timedatectl",
  "hostnamectl",
  "nmcli",
  "pactl",
  "wpctl",
]);

export const SAFE_SUBCOMMANDS: Record<string, Set<string> | null> = {
  systemctl: new Set(["status", "is-active", "is-enabled", "list-units", "list-timers"]),
  journalctl: null, // any args (read-only)
  pacman: new Set(["-Q", "-Qi", "-Qs", "-Ql", "-Qe", "-Qu", "-Ss", "-Si"]),
  git: new Set(["status", "log", "diff", "branch", "show"]),
};

const SHELL_META = /[;&|<>`$(){}\n\\*?!]/;
/** Pipes / redirection / substitution — never allowed, not even in a skill line. */
const INJECTION_META = /[|<>`$\n]/;
const SENSITIVE =
  /\.ssh|\.gnupg|id_rsa|id_ed25519|\.pki|keyring|secret|token|passw|\.netrc|\.env\b|credentials|\/etc\/shadow|cookies|\.mozilla|chromium/i;

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

function resolveTok(tok: string, cwd: string): string {
  if (tok.startsWith("~")) return expandTilde(tok);
  if (tok.startsWith("/")) return path.normalize(tok);
  return path.resolve(cwd, tok);
}

function insideSkills(tok: string, root: string, cwd: string): boolean {
  const abs = resolveTok(tok, cwd);
  return abs === root || abs.startsWith(root + path.sep);
}

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
const INLINE_CODE_FLAGS = new Set(["-c", "-e", "--eval", "-p"]);
/** Helpers a skill workflow chains around its own script: fetch, read, shuffle (no writes
 *  of consequence, no execution). They are trusted *inside a line that runs a skill*. */
const SKILL_HELPERS = new Set([
  "cd",
  "curl",
  "wget",
  "cat",
  "head",
  "tail",
  "less",
  "grep",
  "awk",
  "sed",
  "tr",
  "sort",
  "uniq",
  "wc",
  "base64",
  "jq",
  "realpath",
  "dirname",
  "basename",
  "mktemp",
  "mkdir",
  "sleep",
  "test",
  "env",
  "printf",
  "echo",
]);

/**
 * Does the command line name at least one path inside the skills directory?
 * (A URL is not a local path, so `read_url.ts "https://…"` still counts.)
 */
export function isSkillCommand(command: string, skillsDir?: string): boolean {
  if (!skillsDir) return false;
  const root = expandTilde(skillsDir).replace(/\/+$/, "");
  if (!root) return false;
  let argv: string[];
  try {
    argv = shlexSplit(command);
  } catch {
    return false;
  }
  return argv.some((tok) => looksLikeLocalPath(tok) && insideSkills(tok, root, HOME));
}

const HOME = process.env.HOME ?? "/";

/** One `&&` / `;` segment: what is actually being executed? */
function segmentTrusted(toks: string[], root: string, cwd: string): boolean {
  const prog = toks[0];
  if (!prog) return false;
  const base = path.basename(prog);
  if (looksLikeLocalPath(prog) && insideSkills(prog, root, cwd)) return true; // the skill's own file
  if (INTERPRETERS.has(base)) {
    if (toks.slice(1).some((t) => INLINE_CODE_FLAGS.has(t))) return false; // -c/-e one-liners
    const firstPath = toks.slice(1).find(looksLikeLocalPath);
    return Boolean(firstPath) && insideSkills(firstPath!, root, cwd);
  }
  return SAFE_COMMANDS.has(base) || SKILL_HELPERS.has(base);
}

/**
 * A *skill* line: names a path under the skills directory and every segment of it
 * executes something sensible — the skill's own file, an interpreter pointed at it, or a
 * read-only/fetch helper. That is what lets `curl … -o /tmp/x.html && python3
 * <skills>/extract_ddg.py /tmp/x.html` run unattended (the user's own skills are trusted),
 * while `curl … && rm -rf ~`, `bash /tmp/evil.sh <skills>/y` and `python3 -c '…'` still
 * stop at the approval prompt. Pipes, redirection and substitution are refused outright,
 * and so is a word that smuggles a separator inside it (`cat <skills>/x;rm -rf ~`) —
 * the shell honours that glue; the segment model below does not describe it.
 */
export function isTrustedSkillLine(command: string, skillsDir: string): boolean {
  if (INJECTION_META.test(command)) return false;
  let words: ShlexWord[];
  try {
    words = shlexSplitWords(command);
  } catch {
    return false;
  }
  const root = expandTilde(skillsDir).replace(/\/+$/, "");
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
      const next = resolveTok(seg[1]!, cwd);
      if (next !== root && !next.startsWith(root + path.sep)) return false;
      cwd = next;
      continue;
    }
    if (!segmentTrusted(seg, root, cwd)) return false;
  }
  return true;
}

export function isSafeCommand(command: string, skillsDir?: string): boolean {
  if (SENSITIVE.test(command)) return false;
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
  if (SAFE_COMMANDS.has(prog)) return true;
  if (prog in SAFE_SUBCOMMANDS) {
    const allowed = SAFE_SUBCOMMANDS[prog]!;
    return allowed === null || (argv.length > 1 && allowed.has(argv[1]!));
  }
  return false;
}

/**
 * Does the command line name something in the sensitive set (`.ssh`, keys, `.env`,
 * credentials, browser profiles …)? `isSafeCommand` already answers "no" for these —
 * the value of this function is telling a *caller that does not consult `safe`* (the
 * `CMD_MODE=auto` path in `tools.ts`, where nothing else would stop the call) that this
 * exact command is the one that must not run unattended.
 */
export function isSensitiveCommand(command: string): boolean {
  return SENSITIVE.test(command);
}
