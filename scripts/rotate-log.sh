#!/usr/bin/env bash
# rotate-log.sh — sourced, not executed. `rotate_log <file> [max_bytes]` renames <file>
# to <file>.1 before it grows past max_bytes (default: $LOG_MAX_BYTES, else 5 MiB).
#
# The scripts that own a long-lived log (the audio.cpp servers, the UI/dbg harness and
# Chromium captures) call this right before they truncate-and-redirect into the file, so
# the previous run is kept as one generation instead of being overwritten outright and
# the current one cannot grow without bound. One generation on purpose: these are
# diagnostics, and data/logs/ is a handful of files, not a log store.

rotate_log() {
  local file="$1" max="${2:-${LOG_MAX_BYTES:-5242880}}" size
  [ -f "$file" ] || return 0
  size="$(wc -c <"$file" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$size" ] || return 0
  if [ "$size" -ge "$max" ]; then
    mv -f "$file" "$file.1"
  fi
}
