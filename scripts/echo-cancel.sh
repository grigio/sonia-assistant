#!/usr/bin/env bash
# echo-cancel.sh — PipeWire WebRTC echo cancellation so barge-in works on laptop speakers.
#   scripts/echo-cancel.sh on   → creates fd_ec_source / fd_ec_sink, prints the env to use
#   scripts/echo-cancel.sh off  → unloads it
# With headphones you don't need this.
#
# The module lives in the *user's* PipeWire, so it dies with the session — that is
# what `scripts/install-echo-cancel.sh` (a systemd --user unit) is for. Run this
# by hand only when you don't want the unit.
set -euo pipefail

# The unit starts at login, racing PipeWire's own socket activation: without this
# `pactl` fails with "Connection refused" and the unit is left dead until the next
# login. Bounded, so a genuinely broken PipeWire still fails loudly.
wait_for_pulse() {
  local n=0
  until pactl info >/dev/null 2>&1; do
    n=$((n + 1))
    [ "$n" -ge 30 ] && { echo "echo-cancel: no Pulse/PipeWire server after 30s" >&2; return 1; }
    sleep 1
  done
}

case "${1:-on}" in
  on)
    wait_for_pulse
    if pactl list short modules | grep -q "source_name=fd_ec_source"; then
      echo "already loaded"
    else
      pactl load-module module-echo-cancel aec_method=webrtc \
        source_name=fd_ec_source sink_name=fd_ec_sink \
        aec_args='"analog_gain_control=0 digital_gain_control=1 noise_suppression=1"' >/dev/null
      echo "loaded module-echo-cancel"
    fi
    echo "run with:  MIC_TARGET=fd_ec_source SPK_TARGET=fd_ec_sink bun run start"
    ;;
  off)
    wait_for_pulse
    for id in $(pactl list short modules | awk '/module-echo-cancel/ && /fd_ec_source/ {print $1}'); do
      pactl unload-module "$id"; echo "unloaded $id"
    done ;;
  *) echo "usage: $0 on|off" >&2; exit 1 ;;
esac