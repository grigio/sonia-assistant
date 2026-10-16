#!/usr/bin/env bun
/**
 * `bun run runtime-check` — are the services the harness talks to actually up?
 *
 * Every endpoint comes from the same `Config` the harness itself reads (`.env` first,
 * real environment wins), so this checks *your* configuration, not hardcoded ports:
 *
 *   ✓ llama-server  the LLM leg on `LLM_BASE_URL` (`/health`), skipped when the pi leg
 *                   runs a remote model that never touches it
 *   ✓ asr / tts / turn   the three audio.cpp servers (`ASR_URL`/`TTS_URL`/`TURN_URL` + `/health`)
 *   ✓ harness       the web UI (`HARNESS_URL`, default `http://127.0.0.1:8095/`)
 *
 * Exit code 0 only when every needed service answers — run it before `bun run start` to see
 * what is still missing, after it to confirm everything is green.
 */
import { Config } from "../src/config";
import { healthUrl } from "../src/health";

const cfg = Config.fromEnv();
const TIMEOUT_MS = 2500;
const tty = Boolean(process.stdout.isTTY);
const paint = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => paint(32, s);
const red = (s: string) => paint(31, s);
const dim = (s: string) => paint(2, s);

type Check = {
  name: string;
  url: string;
  hint: string; // how to bring it up when it does not answer
  skip?: string; // non-null → not needed at all, with the reason
  probe: () => Promise<string>; // detail line, or throws the reason
};

/** GET `url` and parse the body as JSON when it is JSON (HTML/empty → null). */
async function get(url: string): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await r.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON (the harness answers with the HTML page) — status code is enough */
  }
  return { status: r.status, json };
}

/** One-line reason for a failed fetch: "connection refused" beats "fetch failed". */
function reason(e: unknown): string {
  const err = e as {
    name?: string;
    message?: string;
    cause?: { code?: string; message?: string; cause?: { code?: string } };
  };
  const code = err?.cause?.code ?? err?.cause?.cause?.code;
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "host unreachable";
  if (err?.name === "TimeoutError" || code === "ETIMEDOUT") return `no answer in ${TIMEOUT_MS} ms`;
  if (code) return code;
  const msg = err?.cause?.message ?? err?.message ?? String(e);
  // Bun's fetch reports a refused connection as a bare TypeError, no cause at all
  if (/unable to connect|fetch failed/i.test(msg)) return "connection refused — nothing listening";
  return msg;
}

/** audio.cpp `/health` → `{"status":"ok","backend":"vulkan","models":1,…}` */
function audioProbe(url: string) {
  return async (): Promise<string> => {
    const { status, json } = await get(url);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const st = json?.status;
    if (st !== undefined && st !== "ok") throw new Error(`status=${String(st)}`);
    const parts = [
      json?.backend !== undefined ? String(json.backend) : "unknown backend",
      json?.models !== undefined ? `${String(json.models)} model(s)` : null,
    ].filter((p): p is string => p !== null);
    return parts.join(" · ");
  };
}

const llamaHealth = healthUrl(cfg.llmBaseUrl.replace(/\/v1\/?$/, ""));
const harnessUrl = `${(process.env.HARNESS_URL ?? "http://127.0.0.1:8095").replace(/\/+$/, "")}/`;

const checks: Check[] = [
  {
    name: "llama-server",
    url: llamaHealth,
    hint: "systemctl --user start llama-server",
    skip:
      cfg.llmViaPi && !cfg.piModel.startsWith("llamacpp/")
        ? `pi leg with remote model (${cfg.piModel}) — the local server is not needed`
        : undefined,
    probe: async () => {
      const { status, json } = await get(llamaHealth);
      if (status === 503) throw new Error("HTTP 503 — still loading a model?");
      if (status !== 200) throw new Error(`HTTP ${status}`);
      const st = json?.status;
      if (st !== undefined && st !== "ok") throw new Error(`status=${String(st)}`);
      return `model=${cfg.llmModel}`;
    },
  },
  {
    name: "asr",
    url: healthUrl(cfg.asrUrl),
    hint: "scripts/start-audio-servers.sh start",
    probe: audioProbe(healthUrl(cfg.asrUrl)),
  },
  {
    name: "tts",
    url: healthUrl(cfg.ttsUrl),
    hint: "scripts/start-audio-servers.sh start",
    probe: audioProbe(healthUrl(cfg.ttsUrl)),
  },
  {
    name: "turn",
    url: healthUrl(cfg.turnUrl),
    hint: "scripts/start-audio-servers.sh start",
    probe: audioProbe(healthUrl(cfg.turnUrl)),
  },
  {
    name: "harness",
    url: harnessUrl,
    hint: "bun run start",
    probe: async () => {
      const { status } = await get(harnessUrl);
      if (status !== 200) throw new Error(`HTTP ${status}`);
      return "web UI";
    },
  },
];

type Result = { check: Check; ok: boolean; skipped: boolean; detail: string; ms: number };

const results: Result[] = await Promise.all(
  checks.map(async (check): Promise<Result> => {
    if (check.skip) return { check, ok: true, skipped: true, detail: check.skip, ms: 0 };
    const t = performance.now();
    try {
      return {
        check,
        ok: true,
        skipped: false,
        detail: await check.probe(),
        ms: performance.now() - t,
      };
    } catch (e) {
      return { check, ok: false, skipped: false, detail: reason(e), ms: performance.now() - t };
    }
  }),
);

const nameW = Math.max(...results.map((r) => r.check.name.length));
const urlW = Math.max(...results.map((r) => r.check.url.length));
console.log(dim(`runtime-check — endpoints from .env (HARNESS_URL overrides the web UI)\n`));
for (const r of results) {
  const mark = r.skipped ? dim("−") : r.ok ? green("✓") : red("✗");
  const url = r.check.url.padEnd(urlW);
  const detail = r.skipped ? dim(r.detail) : `${r.detail}${dim(` · ${r.ms.toFixed(0)} ms`)}`;
  console.log(`  ${mark} ${r.check.name.padEnd(nameW)}  ${url}  ${r.ok ? detail : red(r.detail)}`);
  if (!r.ok) console.log(`    ${dim("↳ start it:")} ${r.check.hint}`);
}

const down = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped).length;
const up = results.length - down.length - skipped;
console.log(
  `\n${down.length === 0 ? green(`${up}/${results.length - skipped} up`) : red(`${down.length} down`)}` +
    (skipped ? dim(` · ${skipped} not needed`) : ""),
);
process.exit(down.length === 0 ? 0 : 1);
