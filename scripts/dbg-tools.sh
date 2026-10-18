#!/usr/bin/env bash
# ui-test.sh — run the browser-UI test-suite (tests/ui.ts) safely:
#   * a throwaway harness on a spare port, so the window you are actually using keeps
#     its WebSocket, its config and its model untouched;
#   * a dedicated headless Chromium with its own profile — never your app window.
#
#   scripts/ui-test.sh                  # all four tests (check, tool, model, smoke)
#   scripts/ui-test.sh check smoke      # just these
#   UI_TEST_URL=http://127.0.0.1:8095/ scripts/ui-test.sh check   # against a live instance
#
# Prereqs: llama-server on :8080 (the LLM leg), the audio.cpp servers (started on demand).
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/rotate-log.sh
source "$ROOT/scripts/rotate-log.sh"

info() { printf '\033[1;34m[dbg]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[dbg]\033[0m %s\n' "$*" >&2; exit 1; }

pick_port() {
  bun -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

HARNESS_PID="" CHROME_PID="" PROFILE=""
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  [[ -n "$HARNESS_PID" ]] && { kill "$HARNESS_PID" 2>/dev/null || true; wait "$HARNESS_PID" 2>/dev/null || true; }
  [[ -n "$CHROME_PID"  ]] && { kill "$CHROME_PID" 2>/dev/null || true; }
  [[ -n "$PROFILE"  ]] && { pkill -f "user-data-dir=$PROFILE" 2>/dev/null || true; rm -rf "$PROFILE"; }
  exit "$rc"
}
trap cleanup EXIT INT TERM

# ── prereqs ────────────────────────────────────────────────────────────────────
LLM_BASE_URL="${LLM_BASE_URL:-http://127.0.0.1:8080/v1}"
curl -sf -m 3 "${LLM_BASE_URL%/v1}/health" >/dev/null \
  || die "llama-server not reachable at $LLM_BASE_URL — start it first (systemctl --user start llama-server)"
"$ROOT/scripts/start-audio-servers.sh" start >/dev/null   # idempotent

# ── the harness under test ─────────────────────────────────────────────────────
URL="${UI_TEST_URL:-}"
if [[ -z "$URL" ]]; then
  PORT="$(pick_port)"
  URL="http://127.0.0.1:$PORT/"
  LOG="$ROOT/data/logs/dbg-harness.log"
  mkdir -p "$ROOT/data/run" "$ROOT/data/logs"
  info "harness → $URL (log: ${LOG#"$ROOT"/})"
  rotate_log "$LOG"
  # its own pi namespace: the tests' turns must never land in your data/pi conversations
  LLM_VIA_PI=1 PI_CWD="$ROOT/data/run/dbg-pi" \
    bun run src/cli.ts --web --no-browser --port "$PORT" >"$LOG" 2>&1 &
  HARNESS_PID=$!
  # coming up means a.start() finished → the LLM warmup (a cold model load can take minutes)
  for _ in $(seq 1 300); do
    curl -sf -m 2 "$URL" >/dev/null && break
    kill -0 "$HARNESS_PID" 2>/dev/null || { tail -n 20 "$LOG" >&2; die "harness died on startup"; }
    sleep 1
  done
  curl -sf -m 2 "$URL" >/dev/null || { tail -n 20 "$LOG" >&2; die "harness not up after 300 s (see ${LOG#"$ROOT"/})"; }
else
  info "using the instance you pointed at: $URL"
fi

# ── a headless Chromium of our own ─────────────────────────────────────────────
CDP_PORT="$(pick_port)"
PROFILE="$(mktemp -d /tmp/dbg-chrome.XXXXXX)"
CHROME="$(command -v chromium || command -v chromium-browser || command -v google-chrome-stable \
          || echo /usr/lib/chromium/chromium)"
[[ -x "$CHROME" ]] || die "no Chromium binary found"
info "chromium → CDP :$CDP_PORT (profile $PROFILE)"
rotate_log "$ROOT/data/logs/dbg-chromium.log"
"$CHROME" --headless --remote-debugging-port="$CDP_PORT" --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check --disable-gpu --mute-audio \
  --autoplay-policy=no-user-gesture-required about:blank \
  >"$ROOT/data/logs/dbg-chromium.log" 2>&1 &
CHROME_PID=$!
for _ in $(seq 1 50); do
  curl -sf -m 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null && break
  sleep 0.3
done
curl -sf -m 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null \
  || { tail -n 20 "$ROOT/data/logs/dbg-chromium.log" >&2; die "Chromium CDP never came up"; }

# ── the debug script ─────────────────────────────────────────────────────────
set +e
bun run tests/dbg-tools.ts --url "$URL" --cdp "http://127.0.0.1:$CDP_PORT" "$@"
rc=$?
set -e
exit "$rc"
