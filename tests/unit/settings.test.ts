/**
 * `data/settings.json` — the drawer's runtime switches (half-duplex, barge-in, the two
 * mode selects, the pi/API leg, thinking) surviving a restart.
 *
 * The failure this pins: the drawer used to write into the live `Config` and nothing
 * persisted it, so every restart snapped the user's choices back to `.env`. The store is
 * also deliberately forgiving — a missing, torn or hand-edited file yields no overrides,
 * never a startup crash.
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../../src/config";
import { captureSettings, SettingsStore } from "../../src/settings";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function store(): SettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-settings-"));
  dirs.push(dir);
  return new SettingsStore(path.join(dir, "settings.json"));
}

describe("SettingsStore", () => {
  test("a saved snapshot is applied on the next start", () => {
    const s = store();
    const a = Config.fromEnv();
    a.halfDuplex = true;
    a.bargeIn = false;
    a.decisionMode = "always";
    a.cmdMode = "ask";
    a.llmViaPi = true;
    a.llmDisableThinking = false;
    s.save(a);

    const b = Config.fromEnv();
    // start from the opposite of every one of them, then let the store have its say
    b.halfDuplex = false;
    b.bargeIn = true;
    b.decisionMode = "off";
    b.cmdMode = "off";
    b.llmViaPi = false;
    b.llmDisableThinking = true;
    s.apply(b);

    expect(captureSettings(b)).toEqual({
      halfDuplex: true,
      bargeIn: false,
      decisionMode: "always",
      cmdMode: "ask",
      llmViaPi: true,
      llmDisableThinking: false,
    });
  });

  test("no file yet: no overrides, and the Config is left as it was", () => {
    const s = store();
    expect(s.load()).toEqual({});
    const cfg = Config.fromEnv();
    const before = captureSettings(cfg);
    s.apply(cfg);
    expect(captureSettings(cfg)).toEqual(before);
  });

  test("torn / hand-edited / wrong-typed file: the bad parts are dropped, not thrown", () => {
    const s = store();
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.writeFileSync(s.file, JSON.stringify({ halfDuplex: "yes", bargeIn: true, junk: 1 }));
    expect(s.load()).toEqual({ bargeIn: true });

    fs.writeFileSync(s.file, "{ not json");
    expect(s.load()).toEqual({});

    fs.writeFileSync(s.file, "null");
    expect(s.load()).toEqual({});
  });

  test("the stored modes are normalised, so a junk one lands on the safe default", () => {
    const s = store();
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.writeFileSync(s.file, JSON.stringify({ cmdMode: "Ask2", decisionMode: "sometimes" }));
    expect(s.load()).toEqual({ cmdMode: "ask", decisionMode: "auto" });
  });

  test("a failed write costs the persistence, never the session", () => {
    // a directory that cannot exist (a file sits where the dir should be)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-settings-"));
    dirs.push(dir);
    const blocked = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocked, "x");
    const s = new SettingsStore(path.join(blocked, "settings.json"));
    const cfg = Config.fromEnv();
    cfg.bargeIn = false;
    expect(() => s.save(cfg)).not.toThrow();
  });
});
