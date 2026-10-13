import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clip, expandTilde, parseFrontmatter, Skills } from "../../src/skills";

const FM = `---
name: demo
description: One line description.
---
# Demo

body text
`;

const BLOCK_FM = `---
name: fix-wifi
description: |
  First line of a block scalar
  second line of it, wrapped.
license: MIT
---
body
`;

describe("parseFrontmatter", () => {
  test("plain key: value pairs", () => {
    const fm = parseFrontmatter(FM);
    expect(fm["name"]).toBe("demo");
    expect(fm["description"]).toBe("One line description.");
  });

  test("block scalars are folded into one line", () => {
    const fm = parseFrontmatter(BLOCK_FM);
    expect(fm["name"]).toBe("fix-wifi");
    expect(fm["description"]).toBe("First line of a block scalar second line of it, wrapped.");
    expect(fm["license"]).toBe("MIT");
  });

  test("no frontmatter → empty object", () => {
    expect(parseFrontmatter("# just markdown")).toEqual({});
  });
});

describe("helpers", () => {
  test("expandTilde", () => {
    expect(expandTilde("~/x/y")).toBe(path.join(os.homedir(), "x/y"));
    expect(expandTilde("/abs/path")).toBe("/abs/path");
  });

  test("clip keeps short text and marks the cut", () => {
    expect(clip("short", 100)).toBe("short");
    expect(clip("x".repeat(20), 10)).toBe("x".repeat(10) + " …");
  });
});

describe("Skills store", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fd-skills-"));
  const dir = path.join(root, "skills");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(dir, "alpha"), { recursive: true });
  fs.mkdirSync(path.join(dir, "beta"), { recursive: true });
  fs.mkdirSync(path.join(dir, "not-a-skill"), { recursive: true }); // no SKILL.md → ignored
  fs.writeFileSync(path.join(dir, "alpha", "SKILL.md"), FM);
  fs.writeFileSync(path.join(dir, "beta", "SKILL.md"), BLOCK_FM);

  test("lists the skills of the dir, all active by default", () => {
    const s = new Skills({ dir, dataDir });
    const list = s.list();
    expect(list.map((k) => k.name)).toEqual(["demo", "fix-wifi"]);  // frontmatter name wins
    expect(list.every((k) => k.active)).toBe(true);
  });

  test("the UI choice is persisted and read back by a fresh instance", () => {
    const s = new Skills({ dir, dataDir });
    const after = s.setActive(["alpha"]);   // by *directory* name, as the UI sends it
    expect(after.find((k) => k.name === "demo")!.active).toBe(true);
    expect(after.find((k) => k.name === "fix-wifi")!.active).toBe(false);

    const reloaded = new Skills({ dir, dataDir });
    expect(reloaded.isActive("alpha")).toBe(true);
    expect(reloaded.isActive("beta")).toBe(false);
    expect(reloaded.read("beta")).toContain("NOT active");
    expect(reloaded.read("alpha")).toContain("# Demo");
    fs.rmSync(path.join(dataDir, "skills.json"));
  });

  test("read() of an unknown skill says so instead of throwing", () => {
    const s = new Skills({ dir, dataDir });
    expect(s.read("nope")).toContain("No skill named 'nope'");
    expect(s.read("../../etc/passwd")).toContain("Unknown skill");
  });

  test("read() cannot leave the skills dir: `..` is a name, not a path", () => {
    // `<dir>/../SKILL.md` is a real file next to the skills dir, and `..` passed the old
    // character check (it is all allowed characters) — the model picks the argument.
    fs.writeFileSync(path.join(root, "SKILL.md"), "OUTSIDE");
    const s = new Skills({ dir, dataDir });
    expect(s.read("..")).toContain("Unknown skill");
    expect(s.read(".")).toContain("Unknown skill");
    expect(s.read(" .. ")).toContain("Unknown skill");   // trimmed, then refused
    expect(s.read("../skills/alpha")).toContain("Unknown skill");
    expect(fs.readFileSync(path.join(root, "SKILL.md"), "utf-8")).toBe("OUTSIDE"); // untouched
    // a real skill still reads as before
    expect(s.read("alpha")).toContain("# Demo");
    fs.rmSync(path.join(root, "SKILL.md"));
  });

  test("the prompt block names only the active skills", () => {
    const s = new Skills({ dir, dataDir });
    s.setActive(["beta"]);
    const block = s.block();
    expect(block).toContain("fix-wifi");
    expect(block).not.toContain("- demo");
    expect(block).toContain("read_skill");
    fs.rmSync(path.join(dataDir, "skills.json"));
  });

  test("empty selection → nothing may be used", () => {
    const s = new Skills({ dir, dataDir });
    expect(s.setActive([]).length).toBe(2);
    expect(s.block()).toContain("none are active");
    fs.rmSync(path.join(dataDir, "skills.json"));
  });

  test("a missing skills dir is not an error", () => {
    const s = new Skills({ dir: path.join(root, "nope"), dataDir });
    expect(s.list()).toEqual([]);
    expect(s.block()).toContain("none are active");
  });
});
