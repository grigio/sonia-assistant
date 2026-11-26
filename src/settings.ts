/**
 * `data/settings.json` — the handful of knobs the UI settings drawer changes at runtime,
 * remembered across restarts.
 *
 * `Config.fromEnv()` is the environment-derived baseline and stays the source of truth
 * for everything that is *not* a drawer switch. The drawer only ever overrides six of its
 * fields (half-duplex, barge-in, the two mode selects, the pi/API leg, thinking), and
 * those overrides used to be lost on restart: the drawer wrote straight into the live
 * `Config`, nothing persisted them, and the next process came back on the `.env` value.
 *
 * Every runtime write now goes through this store, which is the one place that knows
 * *which* fields are runtime-overridable — so `Config` stays honest about what the
 * environment owns, and the ws handler's effects are visible in one small module.
 */

import fs from "node:fs";
import path from "node:path";
import {
  type CmdMode,
  type Config,
  type DecisionMode,
  normalizeCmdMode,
  normalizeDecisionMode,
} from "./config";
import { writeJsonAtomic } from "./util";

/** The `Config` fields the settings drawer may override — and only those. */
export type RuntimeSettings = {
  halfDuplex: boolean;
  bargeIn: boolean;
  decisionMode: DecisionMode;
  cmdMode: CmdMode;
  llmViaPi: boolean;
  llmDisableThinking: boolean;
};

const BOOL_KEYS = ["halfDuplex", "bargeIn", "llmViaPi", "llmDisableThinking"] as const;

/** The current value of every runtime knob, as the store persists it. */
export function captureSettings(cfg: Config): RuntimeSettings {
  return {
    halfDuplex: cfg.halfDuplex,
    bargeIn: cfg.bargeIn,
    decisionMode: cfg.decisionMode,
    cmdMode: cfg.cmdMode,
    llmViaPi: cfg.llmViaPi,
    llmDisableThinking: cfg.llmDisableThinking,
  };
}

export class SettingsStore {
  constructor(readonly file: string) {}

  /**
   * The stored overrides. Anything unreadable (no file yet, hand-edited garbage, an older
   * shape) yields none of them: an empty settings object beats a startup crash, exactly
   * as `skills.json` and `chat.json` treat their own file.
   */
  load(): Partial<RuntimeSettings> {
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(this.file, "utf-8"));
    } catch {
      return {};
    }
    const obj = data as Record<string, unknown> | null;
    if (typeof obj !== "object" || obj === null) return {};
    const out: Partial<RuntimeSettings> = {};
    for (const key of BOOL_KEYS) {
      if (typeof obj[key] === "boolean") out[key] = obj[key] as boolean;
    }
    if (typeof obj.decisionMode === "string")
      out.decisionMode = normalizeDecisionMode(obj.decisionMode, () => {});
    if (typeof obj.cmdMode === "string") out.cmdMode = normalizeCmdMode(obj.cmdMode, () => {});
    return out;
  }

  /**
   * Apply the stored overrides to `cfg` — call this *before* the `Harness` reads them, so
   * a restart resumes on the settings the user last picked rather than on `.env`.
   */
  apply(cfg: Config): void {
    const s = this.load();
    if (typeof s.halfDuplex === "boolean") cfg.halfDuplex = s.halfDuplex;
    if (typeof s.bargeIn === "boolean") cfg.bargeIn = s.bargeIn;
    if (s.decisionMode !== undefined) cfg.decisionMode = s.decisionMode;
    if (s.cmdMode !== undefined) cfg.cmdMode = s.cmdMode;
    if (typeof s.llmViaPi === "boolean") cfg.llmViaPi = s.llmViaPi;
    if (typeof s.llmDisableThinking === "boolean") cfg.llmDisableThinking = s.llmDisableThinking;
  }

  /**
   * Persist the current snapshot. Best-effort on purpose: a read-only `data/` must cost a
   * silently-unremembered setting, never the turn the user is in the middle of.
   */
  save(cfg: Config): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // keep the keys this store does not own (`location`, set by voice)
      writeJsonAtomic(this.file, { ...readRaw(this.file), ...captureSettings(cfg) }, 1);
    } catch {
      /* the setting holds for this session; the file survives as it was */
    }
  }
}

// ── the user's location ───────────────────────────────────────────────────────────────
// Lives in the same `data/settings.json` under `location`: `set_user_location` writes it;
// the system prompt, `get_weather` and `get_datetime` read it. There is no default: until
// the user says where they are, the assistant asks instead of guessing.

export type UserLocation = {
  city: string;
  country: string;
  timezone: string;
  lat: number;
  lon: number;
};

function readRaw(file: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The saved location, or `null` when none (or an unusable one) is stored. */
export function loadLocation(file: string): UserLocation | null {
  const l = readRaw(file).location as Record<string, unknown> | undefined;
  if (
    l &&
    typeof l.city === "string" &&
    l.city.trim() &&
    typeof l.lat === "number" &&
    typeof l.lon === "number" &&
    Number.isFinite(l.lat) &&
    Number.isFinite(l.lon) &&
    typeof l.timezone === "string" &&
    validTimezone(l.timezone)
  ) {
    return {
      city: l.city,
      country: typeof l.country === "string" ? l.country : "",
      timezone: l.timezone,
      lat: l.lat,
      lon: l.lon,
    };
  }
  return null;
}

/** Persist the location, keeping every other key of the file as it is. */
export function saveLocation(file: string, loc: UserLocation): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, { ...readRaw(file), location: loc }, 1);
}
