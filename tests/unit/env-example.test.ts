/**
 * `.env.example` is documented as *the* full environment-variable reference (README), and
 * every knob in `src/config.ts` is only reachable through it. This test keeps the two in
 * step: a knob added to `Config` without a line here (a silent default nobody can find)
 * fails, and a line here that names a knob we do not have (a typo, a removed setting)
 * fails too.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Config, ROOT } from "../../src/config";

const EXAMPLE = fs.readFileSync(path.join(ROOT, ".env.example"), "utf-8");

/** `llmBaseUrl` → `LLM_BASE_URL`, exactly as `Config.fromEnv()` derives it. */
function envName(key: string): string {
  return key.replace(/([A-Z])/g, "_$1").toUpperCase();
}

/** Every documented line, commented (`#KEY=value`, the tuning knobs) or not. */
const documented = new Set<string>();
/** The lines actually set (uncommented): those are parsed by `Config.fromEnv()`. */
const set: { name: string; value: string }[] = [];
for (const line of EXAMPLE.split("\n")) {
  const m = /^(#)?\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (!m) continue;
  documented.add(m[2]!);
  if (m[1] === undefined) set.push({ name: m[2]!, value: m[3]! });
}

describe(".env.example", () => {
  test("documents every knob of Config", () => {
    const cfg = new Config() as unknown as Record<string, unknown>;
    const missing = Object.keys(cfg)
      .map(envName)
      .filter((name) => !documented.has(name));
    expect(missing).toEqual([]);
  });

  test("names no knob Config does not have", () => {
    const known = new Set(Object.keys(new Config() as unknown as Record<string, unknown>).map(envName));
    const stray = [...documented].filter((name) => !known.has(name));
    // ASR_PRECISION / ASR_GGUF / LLM_MODEL_PATH are read by scripts/, not by Config:
    // they are documented on purpose and belong here as exceptions.
    const byScripts = new Set(["ASR_PRECISION", "ASR_GGUF", "LLM_MODEL_PATH"]);
    expect(stray.filter((name) => !byScripts.has(name))).toEqual([]);
  });

  test("every set value is one Config.fromEnv() would accept", () => {
    const cfg = new Config() as unknown as Record<string, unknown>;
    const byName = new Map(Object.keys(cfg).map((k) => [envName(k), k]));
    for (const { name, value } of set) {
      const key = byName.get(name);
      if (key === undefined) throw new Error(`${name} is not a Config field`);
      const def = cfg[key];
      if (typeof def !== "number" || value.trim() === "") continue; // empty = keep the default
      const n = Number(value.trim());
      if (!Number.isFinite(n)) throw new Error(`${name}=${value} is not a number`);
      // Config truncates integers: a float here would silently change the value
      if (Number.isInteger(def) && !Number.isInteger(n)) {
        throw new Error(`${name}=${value} must be an integer`);
      }
    }
  });
});
