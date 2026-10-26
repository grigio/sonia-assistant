import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const MANIFEST = path.join(ROOT, "scripts/models-manifest.json");
const SCRIPT = path.join(ROOT, "scripts/models-download.ts");

type Entry = { size: number; sha256: string };

describe("the pinned model manifest", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as Record<string, Entry>;

  test("every entry has a positive size and a SHA-256", () => {
    expect(Object.keys(manifest).length).toBeGreaterThan(0);
    for (const [name, e] of Object.entries(manifest)) {
      expect(e.size, name).toBeGreaterThan(0);
      expect(e.sha256, name).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("the downloader uses a commit, never a moving branch", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    expect(src).toContain("const HF_REVISION =");
    expect(src).toContain("const SILERO_REVISION =");
    expect(src).not.toContain("resolve/main");
    expect(src).not.toContain("/master/");
  });
});
