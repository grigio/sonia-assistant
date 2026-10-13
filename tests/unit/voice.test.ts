/**
 * The voice selector in the settings drawer: the list is the TTS pack on disk (one
 * `<voice>.safetensors` per preset), an unknown pick changes nothing, an accepted one
 * is remembered in `data/voice` and restored at the next start.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { Config } from "../../src/config";
import { Assistant } from "../../src/harness/assistant";

describe("TTS voice (settings drawer selector)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-voice-"));
  const pack = path.join(tmp, "pack", "embeddings");
  fs.mkdirSync(pack, { recursive: true });
  for (const v of ["giovanni", "alba", "vera"])
    fs.writeFileSync(path.join(pack, `${v}.safetensors`), "");

  const cfg = new Config();
  cfg.ttsVoiceDir = pack;
  cfg.dataDir = path.join(tmp, "data");
  const a = new Assistant(cfg, null, "null");

  test("the list is the pack's presets, sorted", () => {
    cfg.ttsVoice = "alba"; // the voice in use is always in the list — pick one in the pack
    expect(a.voiceList()).toEqual(["alba", "giovanni", "vera"]);
  });

  test("the voice in use stays selectable even outside the pack", () => {
    cfg.ttsVoice = "fuori_dal_pack";
    expect(a.voiceList()).toContain("fuori_dal_pack");
    cfg.ttsVoice = "giovanni";
  });

  test("picking a voice switches it and remembers the choice", () => {
    a.setVoice("vera");
    expect(cfg.ttsVoice).toBe("vera");
    expect(fs.readFileSync(path.join(cfg.dataDir, "voice"), "utf-8").trim()).toBe("vera");
  });

  test("an unknown voice changes nothing (no such preset in the pack)", () => {
    a.setVoice("pluto");
    a.setVoice("   ");
    expect(cfg.ttsVoice).toBe("vera");
  });

  test("the saved voice is restored at the next start, a stale one ignored", () => {
    const cfg2 = new Config();
    cfg2.ttsVoiceDir = pack;
    cfg2.dataDir = cfg.dataDir;
    const b = new Assistant(cfg2, null, "null");
    expect(b.applySavedVoice()).toBe("vera");
    expect(cfg2.ttsVoice).toBe("vera");
    // the pack lost that voice in the meantime → TTS_VOICE stays the default
    fs.writeFileSync(path.join(cfg.dataDir, "voice"), "sparita\n");
    cfg2.ttsVoice = "giovanni";
    expect(b.applySavedVoice()).toBeNull();
    expect(cfg2.ttsVoice).toBe("giovanni");
  });

  test("no pack on disk → the configured voice is the whole list", () => {
    const cfg3 = new Config();
    cfg3.ttsVoiceDir = path.join(tmp, "non-c'è");
    cfg3.ttsVoice = "giovanni";
    expect(new Assistant(cfg3, null, "null").voiceList()).toEqual(["giovanni"]);
  });

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
});
