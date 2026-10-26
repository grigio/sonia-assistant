import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiSession } from "../../src/clients/pi";
import { Config } from "../../src/config";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sonia-pi-conv-"));
}

describe("pi conv dirs are pruned", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmp();
  });

  test("a startup keeps only the newest conv dirs, and resumes the newest", () => {
    for (let n = 0; n <= 15; n++) {
      fs.mkdirSync(path.join(cwd, `conv${n}`));
      // a session file inside, so the pruning test sees a real dir being removed
      fs.writeFileSync(path.join(cwd, `conv${n}`, "session.json"), "{}");
    }
    fs.mkdirSync(path.join(cwd, "not-a-conv")); // must be left alone

    const cfg = new Config();
    cfg.piCwd = cwd;
    const pi = new PiSession(cfg);

    const left = fs.readdirSync(cwd).sort();
    expect(left).toHaveLength(11); // conv6…conv15 + the unrelated dir
    expect(left.filter((n) => /^conv\d+$/.test(n))).toEqual(
      [
        "conv6",
        "conv7",
        "conv8",
        "conv9",
        "conv10",
        "conv11",
        "conv12",
        "conv13",
        "conv14",
        "conv15",
      ].sort(),
    );
    // the kept dirs keep their contents
    expect(fs.existsSync(path.join(cwd, "conv15", "session.json"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, "conv5", "session.json"))).toBe(false);

    // …and a fresh 🧹 moves on from the resumed number, not from 0
    pi.resetSession();
    expect(path.basename(pi.cwd())).toBe("conv16"); // created on first use
    expect(fs.existsSync(path.join(cwd, "conv16"))).toBe(true);
  });

  test("fewer dirs than the cap: nothing is deleted", () => {
    for (const n of [0, 1, 2]) fs.mkdirSync(path.join(cwd, `conv${n}`));
    const cfg = new Config();
    cfg.piCwd = cwd;
    new PiSession(cfg);
    expect(fs.readdirSync(cwd).sort()).toEqual(["conv0", "conv1", "conv2"]);
  });

  test("no conv dir at all: start at conv0", () => {
    fs.mkdirSync(path.join(cwd, "unrelated"));
    const cfg = new Config();
    cfg.piCwd = cwd;
    const pi = new PiSession(cfg);
    expect(fs.existsSync(pi.cwd())).toBe(true);
    expect(path.basename(pi.cwd())).toBe("conv0");
  });
});
