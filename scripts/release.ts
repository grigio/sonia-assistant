#!/usr/bin/env bun
/**
 * `bun run release <version>` — bump the version everywhere it lives, so it can never
 * drift across the three files that carry it by hand:
 *
 *   package.json                    the app (and the harness UI's stamp)
 *   sonia-gtk4/package.json         the native client
 *   sonia-gtk4/packaging/PKGBUILD   the Arch package (`pkgver`; `pkgrel` resets to 1)
 *
 * The tags and the release itself are still the maintainer's job — this only edits the
 * files, and `tests/unit/version-sync.test.ts` is what fails on CI if one is ever missed.
 *
 *   bun run release 0.3.0
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config";

const raw = (process.argv[2] ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(raw)) {
  console.error(`usage: bun run release <major.minor.patch>   (got ${JSON.stringify(raw)})`);
  process.exit(1);
}

/** Replace the first match of `re` in `file`, returning what stood there before. */
function bump(file: string, re: RegExp, replacer: (before: string) => string): string {
  const abs = path.join(ROOT, file);
  const text = fs.readFileSync(abs, "utf-8");
  const m = re.exec(text);
  if (!m) throw new Error(`${file}: no match for ${re}`);
  const before = m[1] ?? m[0];
  fs.writeFileSync(abs, text.replace(re, replacer(before)));
  return before;
}

const jsonVer = /"version"\s*:\s*"([^"]+)"/;
const pkgbuildVer = /^pkgver=(.*)$/m;
const pkgbuildRel = /^pkgrel=(.*)$/m;

const changes: [string, string, string][] = [
  ["package.json", bump("package.json", jsonVer, () => `"version": "${raw}"`), raw],
  [
    "sonia-gtk4/package.json",
    bump("sonia-gtk4/package.json", jsonVer, () => `"version": "${raw}"`),
    raw,
  ],
  [
    "sonia-gtk4/packaging/PKGBUILD",
    bump("sonia-gtk4/packaging/PKGBUILD", pkgbuildVer, () => `pkgver=${raw}`),
    raw,
  ],
];

// A version bump is a new package revision: pkgrel goes back to 1, or a bumped pkgver
// would ship `sonia-gtk4-<new>-2` for no reason.
const relBefore = bump("sonia-gtk4/packaging/PKGBUILD", pkgbuildRel, () => "pkgrel=1");
changes.push(["sonia-gtk4/packaging/PKGBUILD", relBefore, "1"]);

for (const [file, before, after] of changes) {
  console.log(`${file}: ${before} → ${after}`);
}
console.log(`\nNext: git commit -am "release: v${raw}" && git tag v${raw}`);
