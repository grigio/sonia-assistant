#!/usr/bin/env bash
# install-echo-cancel.sh — make the PipeWire echo canceller survive a reboot.
#
# The GTK client (and the CLI mode) need fd_ec_source / fd_ec_sink to work on
# laptop speakers: without them the assistant hears its own voice through the mic
# and cuts itself off mid-sentence. `module-echo-cancel` is loaded into the
# *user's* PipeWire, so it is gone after every reboot and has to be reloaded at
# each login — this installs a systemd --user unit that does exactly that.
#
#   scripts/install-echo-cancel.sh            install + enable + start now
#   scripts/install-echo-cancel.sh --remove   disable and delete the unit
#
# The unit is machine-local: it lives in ~/.config/systemd/user, and its ExecStart
# is the absolute path of this script's repo checkout, so moving or deleting the
# checkout breaks it (re-run this from the new location).
set -euo pipefail

UNIT_NAME="sonia-echo-cancel.service"
UNIT_DIR="$HOME/.config/systemd/user"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EC="$HERE/echo-cancel.sh"

if [ ! -f "$EC" ]; then
  echo "echo-cancel.sh not found next to this script" >&2
  exit 1
fi

case "${1:-install}" in
  --remove)
    systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
    rm -f "$UNIT_DIR/$UNIT_NAME"
    systemctl --user daemon-reload
    # unload it now too, so "off" really means off
    "$EC" off || true
    echo "removed $UNIT_NAME"
    exit 0
    ;;
  install) ;;
  *) echo "usage: $0 [--remove]" >&2; exit 1 ;;
esac

mkdir -p "$UNIT_DIR"
cat >"$UNIT_DIR/$UNIT_NAME" <<EOF
[Unit]
Description=PipeWire WebRTC echo cancellation (fd_ec_source / fd_ec_sink) for Sonia
Documentation=https://github.com/grigio/sonia-assistant
# Ordered after both the daemon and its socket: the loader waits for a reachable
# Pulse server itself, this just keeps the common case from being the retry one.
After=pipewire.service pipewire-pulse.service pipewire-pulse.socket
Wants=pipewire.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$EC on
ExecStop=$EC off

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME"
echo "installed and started $UNIT_NAME"
systemctl --user --no-pager status "$UNIT_NAME" | head -n 6
echo
echo "Clients pick it up with:  MIC_TARGET=fd_ec_source SPK_TARGET=fd_ec_sink SONIA_AEC=1"
echo "(already set in ~/.config/sonia-gtk4/env by the GTK client install)"