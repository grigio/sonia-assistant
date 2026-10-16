/**
 * `prompts/*.txt` is the one part of this project no compiler looks at: hand-written
 * prose that *code* has to parse and act on. These tests pin the seams — what the judge
 * is allowed to answer, what the gate's answer format is, where the language rule sits —
 * so rewording a prompt cannot quietly break the parser on the other side of it.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { parseToolGate, verdict } from "../../src/clients/llm";
import { Config } from "../../src/config";

const cfg = new Config();
const read = (file: string): string => fs.readFileSync(file, "utf-8");

describe("the prompt files themselves", () => {
  test("all three exist where config says they do, and are not empty", () => {
    for (const file of [cfg.systemPromptFile, cfg.decisionPromptFile, cfg.toolGatePromptFile]) {
      const text = read(file);
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text.charCodeAt(0)).not.toBe(0xfeff); // a BOM would end up in the prompt
    }
  });

  test("the system prompt leads with the language rule (it has to outrank the rest)", () => {
    const text = read(cfg.systemPromptFile);
    // The persona's first line is the rule that makes the model mirror the user; the
    // locale's own default is appended *after* it (Assistant.systemPrompt), so anything
    // written above it competes with the highest-priority instruction in the file.
    expect(text.trimStart().startsWith("LANGUAGE RULE")).toBe(true);
    expect(text).not.toContain("__LOCALE__"); // stamped into the page, never into the prompt
  });
});

describe("prompts/decision.txt ↔ verdict()", () => {
  const text = read(cfg.decisionPromptFile);

  test("it offers exactly the words the parser accepts", () => {
    // what the judge is told to answer …
    expect(text).toMatch(/\bLISTEN\b/);
    expect(text).toMatch(/\bREPLY\b/);
    // … is what `verdict()` reads back, both cases and both spellings
    expect(verdict("LISTEN")).toBe("listen");
    expect(verdict("reply")).toBe("speak");
    expect(verdict(" listen\n")).toBe("listen");
    expect(verdict("RePLY")).toBe("speak");
    expect(verdict("ascolto")).toBe("listen"); // an Italian model answering in Italian
    expect(verdict("rispondo")).toBe("speak");
    expect(verdict("")).toBe("speak"); // nothing intelligible → keep talking
  });

  test("it asks for ONE word: the request is made with max_tokens: 4", () => {
    expect(text).toMatch(/ONE word/i);
    expect(text).not.toMatch(/^\s*\d+\./m); // no numbered rubric — that would need tokens
  });
});

describe("prompts/tool-gate.txt ↔ parseToolGate()", () => {
  const text = read(cfg.toolGatePromptFile);

  test("it names the two answer forms the parser understands", () => {
    expect(text).toMatch(/\bNONE\b/);
    expect(text).toMatch(/\bAnswer ONLY with\s+the numbers/i);
    // the examples it gives are the exact grammar parseToolGate() accepts
    expect(text).toContain('"1", "2,3"');
    expect(parseToolGate('"2,3"', 3)).toEqual(new Set([1, 2]));
    expect(parseToolGate("NONE", 3)).toEqual(new Set());
  });

  test("a denial is still a valid answer: prose without a number = no gate at all", () => {
    // the failure mode the caller turns into "let every call through": if the prompt ever
    // starts asking for a word instead of a number, the gate would silently stop gating
    expect(parseToolGate("ALLOW", 3)).toBeNull();
    expect(parseToolGate("", 3)).toBeNull();
  });
});
