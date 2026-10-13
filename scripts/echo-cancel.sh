#!/usr/bin/env bash
# echo-cancel.sh — PipeWire WebRTC echo cancellation so barge-in works on laptop speakers.
#   scripts/echo-cancel.sh on   → creates fd_ec_source / fd_ec_sink, prints the env to use
#   scripts/echo-cancel.sh off  → unloads it
# With headphones you don't need this.
set -euo pipefail
case "${1:-on}" in
  on)
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
    for id in $(pactl list short modules | awk '/module-echo-cancel/ && /fd_ec_source/ {print $1}'); do
      pactl unload-module "$id"; echo "unloaded $id"
    done ;;
  *) echo "usage: $0 on|off" >&2; exit 1 ;;
esac
