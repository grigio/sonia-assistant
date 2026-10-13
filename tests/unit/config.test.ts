import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Config, PI_DEFAULT_MODEL } from "../../src/config";

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
    process.env["LLM_MAX_TOKENS"] = "512";
    process.env["LLM_TEMPERATURE"] = "0.25";
    process.env["LLM_ENABLE_TOOLS"] = "no";
    process.env["BARGE_IN"] = "0";
    process.env["TTS_VOICE"] = "alba";
    process.env["SILENCE_MS"] = "1200";
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
      process.env["BARGE_IN"] = v;
      expect(Config.fromEnv().bargeIn).toBe(true);
    }
    for (const v of ["0", "false", "no", "off", "anything"]) {
      process.env["BARGE_IN"] = v;
      expect(Config.fromEnv().bargeIn).toBe(false);
    }
  });

  test("empty env value falls back to the default", () => {
    process.env["LLM_MAX_TOKENS"] = "";
    expect(Config.fromEnv().llmMaxTokens).toBe(400);
  });

  test("PI_MODEL without a provider/ prefix is rejected", () => {
    process.env["PI_MODEL"] = "gemma-4-12b-it-qat-q4_0";
    expect(Config.fromEnv().piModel).toBe(PI_DEFAULT_MODEL);
    process.env["PI_MODEL"] = "llamacpp/some-model";
    expect(Config.fromEnv().piModel).toBe("llamacpp/some-model");
  });

  test("DECISION_BASE_URL / DECISION_MODEL map from the env", () => {
    process.env["DECISION_BASE_URL"] = "http://127.0.0.1:8098/v1";
    process.env["DECISION_MODEL"] = "FrogNano-4B-2609-Q4_K_M";
    const cfg = Config.fromEnv();
    expect(cfg.decisionBaseUrl).toBe("http://127.0.0.1:8098/v1");
    expect(cfg.decisionModel).toBe("FrogNano-4B-2609-Q4_K_M");
  });
});
