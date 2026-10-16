/**
 * Skills — the user's own instruction packages, in pi's layout:
 *
 *     <skillsDir>/<name>/SKILL.md      YAML frontmatter (name, description) + instructions
 *     <skillsDir>/<name>/scripts/…     the executable part (run with run_command)
 *
 * Deliberately **no autodiscovery into the prompt**: the system prompt only says that
 * skills exist and where; which ones are *active* is decided by the user in the UI
 * settings drawer. Only the active skills reach the context — through the
 * `skillsBlock()` addendum (name + description) and the `list_skills` / `read_skill`
 * tools. A skill that is switched off is invisible to the model.
 *
 * Commands under the skills dir are trusted by the shell policy (see `isSafeCommand`):
 * the skills are the user's own code.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillInfo } from "./events";
import { writeJsonAtomic } from "./util";

export type { SkillInfo };

/** `~/x` → `$HOME/x` (the current user's home); everything else is returned untouched. */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Minimal YAML frontmatter reader: `key: value` pairs between the `---` fences, with
 * folded/block scalars (`description: |`) joined into one line. Enough for SKILL.md,
 * without pulling a YAML parser into a voice assistant.
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return out;
  let key = "";
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1]!;
      out[key] = kv[2]!.trim();
      continue;
    }
    if (!key) continue;
    const cur = out[key]!;
    if (/^[|>][-+]?$/.test(cur))
      out[key] = line.trim(); // first line of a block
    else if (line.trim()) out[key] = `${cur} ${line.trim()}`.trim();
  }
  for (const k of Object.keys(out)) if (/^[|>][-+]?$/.test(out[k]!)) out[k] = "";
  return out;
}

/** Clip a long text, marking the cut (descriptions, SKILL.md bodies). */
export function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).trimEnd()} …`;
}

export class Skills {
  /** Absolute skills dir (tilde already expanded). */
  readonly dir: string;
  /** `dataDir/skills.json` — the user's UI choice, `null` = every skill in the dir. */
  readonly storePath: string;
  private active: Set<string> | null = null;

  constructor(opts: { dir: string; dataDir: string }) {
    this.dir = expandTilde(opts.dir);
    this.storePath = path.join(opts.dataDir, "skills.json");
    this.active = this.load();
  }

  private load(): Set<string> | null {
    try {
      const v: unknown = JSON.parse(fs.readFileSync(this.storePath, "utf-8"));
      if (Array.isArray(v)) return new Set(v.map(String));
    } catch {
      /* no store yet → the default is "everything active" (like pi exposes its skills) */
    }
    return null;
  }

  /** Every skill currently in the dir, with the active flag the UI renders. */
  list(): SkillInfo[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => !n.startsWith("."));
    } catch {
      return []; // dir missing (or unreadable) → no skills, no error
    }
    const out: SkillInfo[] = [];
    for (const dirName of names.sort()) {
      let text = "";
      try {
        text = fs.readFileSync(path.join(this.dir, dirName, "SKILL.md"), "utf-8");
      } catch {
        continue; // not a skill (no SKILL.md), just a directory
      }
      const fm = parseFrontmatter(text);
      out.push({
        name: fm.name || dirName,
        description: clip(fm.description || "(no description)", 400),
        active: this.isActive(dirName),
      });
    }
    return out;
  }

  isActive(dirName: string): boolean {
    return this.active === null || this.active.has(dirName);
  }

  /** Persist the UI choice; returns the fresh list (what the caller broadcasts). */
  setActive(names: string[]): SkillInfo[] {
    this.active = new Set(names.map(String));
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      writeJsonAtomic(this.storePath, [...this.active].sort(), 1);
    } catch (e) {
      process.stdout.write(`\r\x1b[K[skills] cannot persist ${this.storePath}: ${e}\n`);
    }
    return this.list();
  }

  activeSkills(): SkillInfo[] {
    return this.list().filter((s) => s.active);
  }

  /**
   * The SKILL.md of an *active* skill, clipped. Inactive skills are refused: the user
   * decided what may enter the context, and reading one behind their back would defeat
   * the switch.
   *
   * The name is a **directory of `this.dir`, never a path**: `..` is a name the old
   * character check happily accepted, and `path.join(dir, "..", "SKILL.md")` then read
   * the file one level *above* the skills directory (a model-controlled string reading
   * outside the box it was given). The id must match, must not be `.`/`..`, and must
   * still resolve inside the directory — three checks, where two would do, because the
   * third is the one that stays true if the pattern is ever loosened.
   */
  read(name: string, maxChars = 8000): string {
    const id = String(name ?? "").trim();
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
      return `Unknown skill: ${JSON.stringify(name)}`;
    }
    const abs = path.resolve(this.dir, id);
    if (abs !== this.dir && !abs.startsWith(this.dir + path.sep)) {
      return `Unknown skill: ${JSON.stringify(name)}`;
    }
    let text = "";
    try {
      text = fs.readFileSync(path.join(this.dir, id, "SKILL.md"), "utf-8");
    } catch {
      return `No skill named '${id}' in ${this.dir}. Call list_skills for what exists.`;
    }
    if (!this.isActive(id)) {
      return (
        `Skill '${id}' exists but is NOT active: the user has switched it off in the UI ` +
        `settings, so its instructions must stay out of the conversation.`
      );
    }
    return clip(text, maxChars);
  }

  /**
   * The prompt addendum: names + descriptions of the active skills only. The bodies are
   * *not* inlined — the model fetches one with `read_skill` when it actually needs it.
   */
  block(): string {
    const act = this.activeSkills();
    if (!act.length) {
      return (
        "Skills: none are active right now (the user picks them in the UI settings) — " +
        "do not look for or run any skill scripts."
      );
    }
    return (
      `Skills: instruction packages with scripts, in ${this.dir}. The user activates them ` +
      `in the UI settings; these are the active ones and the only ones you may use:\n` +
      act.map((s) => `- ${s.name}: ${clip(s.description, 240)}`).join("\n") +
      "\nOpen one's instructions with the read_skill tool before running anything of its " +
      "scripts — but only the first time: once read they stay in the conversation, so never " +
      "read the same skill twice in a later turn (the tool says so if you try). Run the " +
      "scripts with run_command (commands inside the skills directory run without " +
      "confirmation), then report the outcome in one or two spoken sentences."
    );
  }
}
