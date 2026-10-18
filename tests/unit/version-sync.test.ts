/**
 * The version lives in three files by hand (`package.json`, `sonia-gtk4/package.json`,
 * `sonia-gtk4/packaging/PKGBUILD`) and one of them lagging is a real bug, not cosmetics:
 * the Arch package would report a version its own `package.json` disagrees with, and the
 * release notes would claim the wrong tag. This keeps them in step — `bun run release`
 * is what moves all three together.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../src/config";

function jsonVersion(rel: string): string {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf-8")) as { version?: unknown };
  return String(data.version ?? "");
}

describe("version sync", () => {
  test("package.json, sonia-gtk4/package.json and PKGBUILD agree", () => {
    const root = jsonVersion("package.json");
    const gtk = jsonVersion("sonia-gtk4/package.json");
    const pkgbuild = fs.readFileSync(path.join(ROOT, "sonia-gtk4/packaging/PKGBUILD"), "utf-8");
    const pkgver = /^pkgver=(.*)$/m.exec(pkgbuild)?.[1]?.trim();
    expect(root).toMatch(/^\d+\.\d+\.\d+$/); // sanity: not an empty read
    expect(gtk).toBe(root);
    expect(pkgver).toBe(root);
  });
});
