#!/usr/bin/env bash
# start-audio-servers.sh — launch the three audio.cpp servers of Stack A:
#   ASR  : Voxtral Mini 4B Realtime q4_k, streaming   (default Vulkan, :8091)
#          ASR_PRECISION=q8_0|bf16 serves another package of the same model id
#   TTS  : Pocket TTS Italian, streaming              (default CPU,    :8092)
#   TURN : Smart Turn v3.2                            (default CPU,    :8093)
# The LLM is NOT started here: the harness uses the already-running llama-server (:8080).
#
# Build prereq: audio.cpp is vendored at vendor/audio.cpp in this repo and must be built:
#   bun run fetch-and-compile-audio.cpp      (fetches the latest release + compiles it)
#   …or by hand: cmake -S vendor/audio.cpp -B vendor/audio.cpp/build -G Ninja \
#         -DCMAKE_BUILD_TYPE=Release -DENGINE_ENABLE_VULKAN=ON \
#         && cmake --build vendor/audio.cpp/build --target audiocpp_server
# Or point AUDIOCPP_SERVER at an already-built audiocpp_server binary.
# The `start` action prints the audio.cpp version it is about to run (git tag + build);
# each server logs to data/logs/<name>.log (pids and configs stay in data/run/).
#
# Usage: scripts/start-audio-servers.sh [start [asr|tts|turn ...]|stop|status]
# Env:   ASR_BACKEND=vulkan TTS_BACKEND=cpu TURN_BACKEND=cpu THREADS=8
#        ASR_PORT=8091 TTS_PORT=8092 TURN_PORT=8093
#        ASR_PRECISION=q4_k|q8_0|bf16 TTS_PRECISION=bf16|q8_0
#        TTS_LANG=italian|english|german|portuguese|spanish  (the Pocket TTS pack +
#        its `language` load option; `bun run models-download` fetches it)
#        (a project .env is honoured too; a real environment variable always wins)
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"

# project .env (same keys as src/config.ts); a real environment variable always wins
if [[ -f "$ROOT/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      [[ -n "${!key+x}" ]] || export "$line" || true
    fi
  done < "$ROOT/.env"
fi

BIN="${AUDIOCPP_SERVER:-$ROOT/vendor/audio.cpp/build/bin/audiocpp_server}"
RUN="$ROOT/data/run"        # pid files + server configs (state)
LOGS="$ROOT/data/logs"      # *.log only — git-ignored, see .gitignore
M="${MODELS_DIR:-$ROOT/models}"
case "$M" in /*) ;; *) M="$ROOT/${M#./}" ;; esac
mkdir -p "$RUN" "$LOGS"

ASR_BACKEND="${ASR_BACKEND:-vulkan}"
TTS_BACKEND="${TTS_BACKEND:-cpu}"
TURN_BACKEND="${TURN_BACKEND:-cpu}"
ASR_PORT="${ASR_PORT:-8091}"
TTS_PORT="${TTS_PORT:-8092}"
TURN_PORT="${TURN_PORT:-8093}"
THREADS="${THREADS:-8}"
TTS_PRECISION="${TTS_PRECISION:-bf16}"
TTS_LANG="${TTS_LANG:-italian}"
ASR_PRECISION="${ASR_PRECISION:-q4_k}"
ASR_GGUF="${ASR_GGUF:-$M/Voxtral-Mini-4B-Realtime-2602-GGUF/voxtral-mini-4b-realtime-2602-$ASR_PRECISION.gguf}"
TTS_GGUF="${TTS_GGUF:-$M/PocketTTS-GGUF/$TTS_LANG/pocket-tts-$TTS_LANG-$TTS_PRECISION.gguf}"
TURN_GGUF="${TURN_GGUF:-$M/Smart-Turn-v3-GGUF/smart-turn-v3.2-f32.gguf}"
ASR_BATCH_TOKENS="${ASR_BATCH_TOKENS:-4}"

info(){ printf "\033[1;34m[audio]\033[0m %s\n" "$*"; }
warn(){ printf "\033[1;33m[audio]\033[0m %s\n" "$*" >&2; }
die(){ printf "\033[1;31m[err]\033[0m %s\n" "$*" >&2; exit 1; }

# Which audio.cpp is this? — the tag the vendored source sits at plus the binary's own
# `--version` (commit, compiler, backends). Printed by `start`, i.e. by `bun run start` too.
print_version() {
  local tag build
  tag="$(git -C "$ROOT/vendor/audio.cpp" describe --tags --exact-match 2>/dev/null || true)"
  build="$(timeout 5 "$BIN" --version 2>/dev/null || true)"
  info "audio.cpp ${tag:-${build#audio.cpp }} — ${BIN#"$ROOT"/}"
  [[ -n "$build" ]] && printf '%s\n' "$build" | tail -n +2 | sed 's/^/        /'
  return 0
}

write_configs() {
  cat > "$RUN/asr.json" <<JSON
{
  "host": "127.0.0.1", "port": $ASR_PORT, "backend": "$ASR_BACKEND", "device": 0,
  "threads": $THREADS, "lazy_load": false, "busy_timeout_ms": 0,
  "live_ingest": { "total_timeout_ms": 0, "idle_timeout_ms": 60000 },
  "models": [
    { "id": "voxtral", "family": "voxtral_realtime", "path": "$ASR_GGUF",
      "task": "asr", "mode": "streaming",
      "session_options": { "voxtral_realtime.stream_batch_tokens": "$ASR_BATCH_TOKENS" } }
  ]
}
JSON
  cat > "$RUN/tts.json" <<JSON
{
  "host": "127.0.0.1", "port": $TTS_PORT, "backend": "$TTS_BACKEND", "device": 0,
  "threads": $THREADS, "lazy_load": false,
  "models": [
    { "id": "pocket-it", "family": "pocket_tts", "path": "$TTS_GGUF",
      "task": "tts", "mode": "streaming",
      "load_options": { "language": "$TTS_LANG" } }
  ]
}
JSON
  cat > "$RUN/turn.json" <<JSON
{
  "host": "127.0.0.1", "port": $TURN_PORT, "backend": "$TURN_BACKEND", "device": 0,
  "threads": 4, "lazy_load": false,
  "models": [
    { "id": "smart-turn", "family": "smart_turn", "path": "$TURN_GGUF",
      "task": "turn", "mode": "offline" }
  ]
}
JSON
}

start_one() {  # name port
  local name="$1" port="$2"
  if ss -tlnH 2>/dev/null | grep -qE "127.0.0.1:${port}\b"; then
    info "$name already listening on :$port"; return
  fi
  info "starting $name on :$port → ${LOGS#"$ROOT"/}/$name.log"
  nohup setsid "$BIN" --config "$RUN/$name.json" --no-ui --log >"$LOGS/$name.log" 2>&1 </dev/null &
  echo $! > "$RUN/$name.pid"
}

wait_ready() {  # name port
  local name="$1" port="$2"
  for _ in $(seq 1 240); do
    if curl -sf -m 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      info "$name ready"; return 0
    fi
    if [[ -f "$RUN/$name.pid" ]] && ! kill -0 "$(cat "$RUN/$name.pid")" 2>/dev/null; then
      tail -n 20 "$LOGS/$name.log" >&2; die "$name died"
    fi
    sleep 1
  done
  die "$name not ready after 240 s (see ${LOGS#"$ROOT"/}/$name.log)"
}

stop_all() {
  local n port pid i
  for n in asr tts turn; do
    case "$n" in asr) port=$ASR_PORT ;; tts) port=$TTS_PORT ;; turn) port=$TURN_PORT ;; esac
    if [[ -f "$RUN/$n.pid" ]]; then
      kill "$(cat "$RUN/$n.pid")" 2>/dev/null && info "stopped $n" || true
      rm -f "$RUN/$n.pid"
    fi
    # stale pid file / started by hand → fall back to whoever holds the port
    pid="$(ss -tlnpH "sport = :$port" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -n1 | cut -d= -f2 || true)"
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null && info "stopped $n on :$port (pid $pid)" || true
    fi
  done
  for n in asr tts turn; do
    case "$n" in asr) port=$ASR_PORT ;; tts) port=$TTS_PORT ;; turn) port=$TURN_PORT ;; esac
    for i in $(seq 1 20); do
      ss -tlnH "sport = :$port" 2>/dev/null | grep -q . || break
      sleep 0.5
    done
    ss -tlnH "sport = :$port" 2>/dev/null | grep -q . \
      && warn ":$port still listening — kill it by hand (pid $(ss -tlnpH "sport = :$port" | grep -oE 'pid=[0-9]+' | head -n1))" || true
  done
}

case "${1:-start}" in
  start)
    [[ -x "$BIN" ]] || die "missing $BIN — run: bun run fetch-and-compile-audio.cpp (or set AUDIOCPP_SERVER)"
    shift || true
    print_version
    NAMES=("$@"); (( ${#NAMES[@]} )) || NAMES=(asr tts turn)
    write_configs
    for n in "${NAMES[@]}"; do
      case "$n" in
        asr)  [[ -f "$ASR_GGUF" ]]  || die "missing $ASR_GGUF — fetch it with: bun run models-download (ASR_PRECISION=$ASR_PRECISION)";  start_one asr "$ASR_PORT" ;;
        tts)  [[ -f "$TTS_GGUF" ]]  || die "missing $TTS_GGUF — fetch it with: bun run models-download (TTS_LANG=$TTS_LANG, TTS_PRECISION=$TTS_PRECISION)";  start_one tts "$TTS_PORT" ;;
        turn) [[ -f "$TURN_GGUF" ]] || die "missing $TURN_GGUF — fetch it with: bun run models-download"; start_one turn "$TURN_PORT" ;;
        *) die "unknown server $n (asr|tts|turn)" ;;
      esac
    done
    for n in "${NAMES[@]}"; do
      case "$n" in asr) wait_ready asr "$ASR_PORT" ;; tts) wait_ready tts "$TTS_PORT" ;; turn) wait_ready turn "$TURN_PORT" ;; esac
    done
    ;;
  stop) stop_all ;;
  status)
    for p in "asr $ASR_PORT" "tts $TTS_PORT" "turn $TURN_PORT"; do
      set -- $p; printf "%-5s :%s  " "$1" "$2"; curl -s -m 2 "http://127.0.0.1:$2/health" || printf "down"; echo
    done ;;
  *) die "usage: $0 [start|stop|status]" ;;
esac
