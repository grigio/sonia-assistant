import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Config, clampNumeric, PI_DEFAULT_MODEL } from "../../src/config";

const KEYS = [
  "LLM_MAX_TOKENS",
  "LLM_TEMPERATURE",
  "LLM_ENABLE_TOOLS",
  "BARGE_IN",
  "SILENCE_MS",
  "PI_MODEL",
  "DECISION_MODE",
  "DECISION_BASE_URL",
  "DECISION_MODEL",
  "TTS_VOICE",
];

describe("Config.fromEnv", () => {
  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  test("defaults", () => {
    const cfg = Config.fromEnv();
    expect(cfg.llmBaseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(cfg.llmMaxTokens).toBe(400);
    expect(cfg.llmTemperature).toBe(0.7);
    expect(cfg.bargeIn).toBe(true);
    expect(cfg.silenceMs).toBe(900);
    expect(cfg.decisionMode).toBe("auto");
    expect(cfg.decisionBaseUrl).toBe(""); // empty → the judge shares the main leg
    expect(cfg.decisionModel).toBe("");
    expect(cfg.piModel).toBe(PI_DEFAULT_MODEL);
  });

  test("int / float / bool / string coercion", () => {
    process.env.LLM_MAX_TOKENS = "512";
    process.env.LLM_TEMPERATURE = "0.25";
    process.env.LLM_ENABLE_TOOLS = "no";
    process.env.BARGE_IN = "0";
    process.env.TTS_VOICE = "alba";
    process.env.SILENCE_MS = "1200";
    const cfg = Config.fromEnv();
    expect(cfg.llmMaxTokens).toBe(512);
    expect(cfg.llmTemperature).toBe(0.25);
    expect(cfg.llmEnableTools).toBe(false);
    expect(cfg.bargeIn).toBe(false);
    expect(cfg.ttsVoice).toBe("alba");
    expect(cfg.silenceMs).toBe(1200);
  });

  test("bool truthy variants (1/true/yes/on)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " Yes "]) {
      process.env.BARGE_IN = v;
      expect(Config.fromEnv().bargeIn).toBe(true);
    }
    for (const v of ["0", "false", "no", "off", " OFF "]) {
      process.env.BARGE_IN = v;
      expect(Config.fromEnv().bargeIn).toBe(false);
    }
  });

  test("an unrecognised bool warns and keeps the default, never silently false", () => {
    const warnings: string[] = [];
    process.env.BARGE_IN = "flase";
    // bargeIn defaults to true: the typo must not read as "off"
    expect(Config.fromEnv((m) => warnings.push(m)).bargeIn).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("BARGE_IN=flase");
    expect(warnings[0]).toContain("default true");
  });

  test("empty env value falls back to the default", () => {
    process.env.LLM_MAX_TOKENS = "";
    expect(Config.fromEnv().llmMaxTokens).toBe(400);
  });

  test("PI_MODEL without a provider/ prefix is rejected", () => {
    process.env.PI_MODEL = "gemma-4-12b-it-qat-q4_0";
    expect(Config.fromEnv().piModel).toBe(PI_DEFAULT_MODEL);
    process.env.PI_MODEL = "llamacpp/some-model";
    expect(Config.fromEnv().piModel).toBe("llamacpp/some-model");
  });

  test("DECISION_BASE_URL / DECISION_MODEL map from the env", () => {
    process.env.DECISION_BASE_URL = "http://127.0.0.1:8098/v1";
    process.env.DECISION_MODEL = "FrogNano-4B-2609-Q4_K_M";
    const cfg = Config.fromEnv();
    expect(cfg.decisionBaseUrl).toBe("http://127.0.0.1:8098/v1");
    expect(cfg.decisionModel).toBe("FrogNano-4B-2609-Q4_K_M");
  });

  test("a plausible-but-wrong number is clamped, and the typo is named", () => {
    const warnings: string[] = [];
    process.env.TURN_CHECK_MS = "-5";
    process.env.VAD_START_THRESHOLD = "3";
    try {
      const cfg = Config.fromEnv((m) => warnings.push(m));
      expect(cfg.turnCheckMs).toBe(1);
      expect(cfg.vadStartThreshold).toBe(1);
      expect(warnings.some((w) => w.includes("TURN_CHECK_MS=-5"))).toBe(true);
      expect(warnings.some((w) => w.includes("VAD_START_THRESHOLD=3"))).toBe(true);
    } finally {
      delete process.env.TURN_CHECK_MS;
      delete process.env.VAD_START_THRESHOLD;
    }
  });
});

describe("clampNumeric", () => {
  test("clamps to the range a knob declares, and leaves the rest alone", () => {
    const warnings: string[] = [];
    const log = (m: string) => warnings.push(m);
    expect(clampNumeric("llmTemperature", 5, log)).toBe(2);
    expect(clampNumeric("llmTemperature", -1, log)).toBe(0);
    expect(clampNumeric("echoOverlap", 0.6, log)).toBe(0.6);
    expect(clampNumeric("unknownKnob", -42, log)).toBe(-42); // no rule → untouched
    expect(warnings).toHaveLength(2);
  });
});
