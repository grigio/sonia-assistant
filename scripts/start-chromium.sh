#!/usr/bin/env bash
# start-chromium.sh — open the browser UI the right way (mic pre-granted, autoplay allowed).
#
# Use this whenever you closed the harness window, or opened http://localhost:8095
# by hand in a normal Chromium/Firefox: a plain browser does NOT get the
# --user-data-dir=data/run/chromium-profile profile (mic permission) and does NOT get
# --autoplay-policy=no-user-gesture-required (TTS autoplay), so the TTS is silent.
#
#   scripts/start-chromium.sh              # opens http://127.0.0.1:8095/
#   scripts/start-chromium.sh --no-check    # open even if the harness isn't up yet
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$ROOT"

URL="${URL:-http://127.0.0.1:8095/}"
if [[ "${1:-}" != "--no-check" ]] && ! curl -sf -m 3 "$URL" >/dev/null; then
  echo "harness not reachable at $URL — start it first:  bun run start" >&2
  echo "(or pass --no-check to open the page anyway)" >&2
  exit 1
fi

exe="$(command -v chromium || command -v chromium-browser || command -v google-chrome-stable \
       || command -v google-chrome || true)"
[[ -n "$exe" ]] || { echo "no chromium/chrome found in PATH" >&2; exit 1; }

# Same profile + flags as the harness' own launch (src/web.ts: launchChromium/pregrantMic):
#   --user-data-dir  dedicated profile with the mic pre-granted for this origin
#   --autoplay-policy  lets the WebRTC AEC-loopback <audio> element play without a gesture
#   --app            frameless app window instead of a full browser with tabs
# If an instance with this profile is already running, Chromium just opens a new
# window/tab in it and this invocation exits.
exec "$exe" "--app=$URL" \
  --user-data-dir="$ROOT/data/run/chromium-profile" \
  --autoplay-policy=no-user-gesture-required \
  --disable-features=Translate \
  --no-first-run --no-default-browser-check \
  --window-size=900,760
