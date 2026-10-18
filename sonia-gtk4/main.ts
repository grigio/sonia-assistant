/**
 * `bun run sonia-gtk4` — the native GTK4 client for the sonia-assistant harness.
 *
 * This script starts NOTHING but the GTK4 app: the backends (llama-server,
 * audio.cpp servers, harness on :8095) must already be up — run `bun run start`
 * in another terminal first. It connects to the same `/ws` the browser UI uses
 * (`src/web.ts`). Everything is configured through
 * the same env the harness reads (Bun exports the project `.env` itself — run the
 * client from the repo root, or let `scripts/sonia-gtk4` launcher do it):
 *
 *   HARNESS_URL   harness base URL      (default http://127.0.0.1:8095)
 *   LOCALE        it | en               (UI language; falls back to the .env, then it)
 *   MIC_TARGET    capture device        (e.g. fd_ec_source with scripts/echo-cancel.sh)
 *   SPK_TARGET    playback device       (e.g. fd_ec_sink)
 *   SONIA_AEC     1 | 0                 (start with the system AEC engaged, default 1
 *                                        when the fd_ec nodes exist)
 *
 *   bun run start                (other terminal: all the backends, no Chromium)
 *   bun run gtk4                (from the repo root — same as `bun run sonia-gtk4`)
 *   sonia-gtk4 install.sh       (system/user install: .desktop + icon + launcher)
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { SoniaApp } from "./app";

// Repo root — where a project .env would live. The packaged client (Arch
// `sonia-gtk4`) runs from /usr/lib/sonia-gtk4, so it sets SONIA_GTK4_ROOT to
// /etc/sonia-gtk4 where its own env file sits.
const ROOT = process.env.SONIA_GTK4_ROOT ?? path.resolve(import.meta.dir, "..");

/** HARNESS_URL (any shape) → `ws://host[:port]/ws`. */
export function wsUrlFrom(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    u = new URL("http://127.0.0.1:8095");
  }
  const ws = new URL(u.toString());
  ws.protocol = u.protocol === "https:" || u.protocol === "wss:" ? "wss:" : "ws:";
  if (!ws.pathname || ws.pathname === "/") ws.pathname = "/ws";
  return ws.toString();
}

/** LOCALE from the env, else the project `.env`, else Italian (the source catalogue). */
export function resolveLocale(): string {
  const env = process.env.LOCALE;
  if (env === "it" || env === "en") return env;
  try {
    const dotenv = fs.readFileSync(path.join(ROOT, ".env"), "utf-8");
    const m = dotenv.match(/^LOCALE=(it|en)\s*$/m);
    if (m) return m[1]!;
  } catch {
    /* no .env — the client still works with the default */
  }
  return "it";
}

/** Are the echo-cancel.sh nodes there? (`pactl` sees module-echo-cancel's sources.) */
export function ecNodesPresent(): boolean {
  try {
    const r = spawnSync("pactl", ["list", "short", "sources"], {
      encoding: "utf-8",
    });
    return r.stdout.includes("fd_ec_source");
  } catch {
    return false;
  }
}

// Preflight: the client is only a window — it never starts the backends itself.
// The harness serves no health route, so just check that something listens there.
function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = net.connect({ host, port });
    s.once("connect", () => s.end(() => res(true)));
    s.once("error", () => res(false));
    setTimeout(() => s.destroy(), 2000).unref();
  });
}

const harnessUrl = process.env.HARNESS_URL ?? "http://127.0.0.1:8095";
{
  const u = new URL(harnessUrl.includes("://") ? harnessUrl : `http://${harnessUrl}`);
  if (!(await portOpen(u.hostname, Number(u.port || 8095)))) {
    console.error(
      `No harness answering at ${harnessUrl} — start the backends first:\n` +
        `  bun run start        # llama-server + audio.cpp servers + harness, no Chromium\n` +
        `  bun run gtk4         # this app, in another terminal`,
    );
    process.exit(1);
  }
}

/** App version from package.json — shown in the about dialog. */
export function appVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(import.meta.dir, "package.json"), "utf-8")).version;
  } catch {
    return "?";
  }
}

const aecPresent = ecNodesPresent();
const app = new SoniaApp({
  wsUrl: wsUrlFrom(harnessUrl),
  locale: resolveLocale(),
  micTarget: process.env.MIC_TARGET ?? (aecPresent ? "fd_ec_source" : ""),
  spkTarget: process.env.SPK_TARGET ?? (aecPresent ? "fd_ec_sink" : ""),
  aecSource: aecPresent ? "fd_ec_source" : "",
  aecSink: aecPresent ? "fd_ec_sink" : "",
  aecDefault: process.env.SONIA_AEC !== "0" && aecPresent,
  version: appVersion(),
});

await app.run();
