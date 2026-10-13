import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../../src/config";
import { Assistant } from "../../src/harness/assistant";
import { Skills } from "../../src/skills";
import { t, type Locale } from "../../src/i18n";
import { PI_SYSTEM_TAIL } from "../../src/clients/pi";

/** The block `Skills.block()` appends — the persona file itself never carries it. */
const BLOCK_MARK = "instruction packages with scripts, in";

describe("system prompt = persona file + the UI-activated skills", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-spk-"));
  const dir = path.join(tmp, "skills");
  fs.mkdirSync(path.join(dir, "demo"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "demo", "SKILL.md"),
    "---\nname: demo\ndescription: A demo.\n---\nbody\n",
  );
  const dataDir = path.join(tmp, "data");

  test("persona + skills block when tools are on", () => {
    const cfg = Config.fromEnv();
    cfg.llmEnableTools = true;
    const a = new Assistant(cfg, null, "null");
    a.skills = new Skills({ dir, dataDir });
    // the persona file comes first, verbatim — the skills block is appended after it
    const persona = fs.readFileSync(cfg.systemPromptFile, "utf-8").trim();
    expect(a.systemPrompt.startsWith(persona)).toBe(true);
    expect(a.systemPrompt).toContain(BLOCK_MARK);
    expect(a.systemPrompt).toContain("- demo: A demo.");
    expect(a.systemPrompt).toContain("read_skill");
    // the reply language follows the user's, it is never forced to Italian
    expect(a.systemPrompt).toMatch(/mirror/);
    fs.rmSync(path.join(dataDir, "skills.json"), { force: true });
  });

  test("without tools there is nothing to point at → persona alone", () => {
    const cfg = Config.fromEnv();
    cfg.llmEnableTools = false;
    const a = new Assistant(cfg, null, "null");
    a.skills = new Skills({ dir, dataDir });
    expect(a.systemPrompt).not.toContain(BLOCK_MARK);
  });

  test("the pi leg brings its own skills → persona alone", () => {
    const cfg = Config.fromEnv();
    cfg.llmViaPi = true;
    const a = new Assistant(cfg, null, "null");
    a.skills = new Skills({ dir, dataDir });
    expect(a.systemPrompt).not.toContain(BLOCK_MARK);
  });

  test("an empty selection is announced too", () => {
    const cfg = Config.fromEnv();
    cfg.llmEnableTools = true;
    const a = new Assistant(cfg, null, "null");
    a.skills = new Skills({ dir, dataDir });
    a.setActiveSkills([]);
    expect(a.systemPrompt).toContain("none are active");
    fs.rmSync(path.join(dataDir, "skills.json"), { force: true });
  });
});

/**
 * The trailing language default: the one line that makes `LOCALE=en` actually answer in
 * English. The persona's "mirror the user" rule sits *above* the skills block, and a 4B
 * model then drifts back to Italian (measured live: 5/5 English questions answered in
 * Italian without this line, 0/5 with it — both for English and Italian input).
 */
describe("the locale's language default is the last line of the prompt", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-lang-"));
  const dir = path.join(tmp, "skills");
  fs.mkdirSync(path.join(dir, "demo"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "demo", "SKILL.md"),
    "---\nname: demo\ndescription: A demo.\n---\nbody\n",
  );
  const dataDir = path.join(tmp, "data");

  const promptFor = (locale: Locale): string => {
    const cfg = Config.fromEnv();
    cfg.locale = locale;
    cfg.llmEnableTools = true;
    const a = new Assistant(cfg, null, "null");
    a.skills = new Skills({ dir, dataDir });
    return a.systemPrompt;
  };

  test("LOCALE=en → the English line, after the skills block", () => {
    const prompt = promptFor("en");
    expect(prompt).toContain(BLOCK_MARK);
    expect(prompt.endsWith(t("en", "prompt.langDefault"))).toBe(true);
    expect(t("en", "prompt.langDefault")).toContain("Language default: ENGLISH");
    expect(prompt).not.toContain("Lingua predefinita");
  });

  test("LOCALE=it → the Italian line, after the skills block", () => {
    const prompt = promptFor("it");
    expect(prompt.endsWith(t("it", "prompt.langDefault"))).toBe(true);
    expect(t("it", "prompt.langDefault")).toContain("Lingua predefinita: ITALIANO");
    expect(prompt).not.toContain("Language default: ENGLISH");
  });

  test("without tools the persona is still first and the line still last", () => {
    const cfg = Config.fromEnv();
    cfg.locale = "en";
    cfg.llmEnableTools = false;
    const a = new Assistant(cfg, null, "null");
    a.skills = new Skills({ dir, dataDir });
    expect(a.systemPrompt.startsWith(fs.readFileSync(cfg.systemPromptFile, "utf-8").trim())).toBe(
      true,
    );
    expect(a.systemPrompt.endsWith(t("en", "prompt.langDefault"))).toBe(true);
    expect(a.systemPrompt).not.toContain(BLOCK_MARK);
  });

  test("the pi leg carries the same line at the end of its own addendum", () => {
    for (const locale of ["it", "en"] as const) {
      const tail = PI_SYSTEM_TAIL(locale);
      expect(tail.endsWith(t(locale, "prompt.langDefault"))).toBe(true);
      expect(tail).toContain(t(locale, "pi.addendum").trim().slice(1, 40)); // the pi rules stay first
    }
  });
});

/**
 * Which end of a list coming from the web is the newest one. A homepage lists its posts
 * newest first, and the model twice answered "the latest post" with the LAST entry of the
 * page (grigio.org, data/logs/harness.log 12:31:37 and 12:48:15) — it read the list bottom-up,
 * and a clipped output made the bottom look like the freshest part of the page. The rules
 * below are what it is given instead; both legs get them (the pi leg runs this file too).
 */
describe("the persona knows where the newest item of a web list is", () => {
  const persona = fs.readFileSync(Config.fromEnv().systemPromptFile, "utf-8");

  test("\"the newest post\" comes from the page's order, not from its text", () => {
    // Skill-agnostic on purpose: the rule hands the model a command of its own (curl + a
    // grep of the page's own links), never a skill's script nor its flags — measured on
    // Qwen3.5-4B-MTP with grigio.org (data/logs/harness.log 12:31:37 and 12:48:15 named a post
    // from the bottom/middle of the list): 1/5 and 2/8 correct with the old wording, 11/16
    // with this one, and 8/8 of the runs that actually listed the links first.
    expect(persona).toMatch(/FIRST list the page's own\s+post links/);
    expect(persona).toContain(`grep -o 'href="/[^"]*"' | head -25`);
    expect(persona).toMatch(/the first entry is the newest post, the last entry is the oldest/);
    expect(persona).toMatch(/Never answer\s+with the last entry/);
    expect(persona).toMatch(/never by guessing\s+from a wall of page text/);
    // …and it assumes no skill in particular: no script, no flag, no skill name
    expect(persona).not.toMatch(/read_url|--headings|websurfx|hackernews|yextractor/);
  });

  test("a clipped output ends at the mark: what follows it is not newer content", () => {
    expect(persona).toMatch(/comes CUT/);
    expect(persona).toMatch(/below the mark is the END of the original output/);
    expect(persona).toMatch(/not something newer that came after it/);
  });
});
