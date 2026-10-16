# Arch package — sonia-gtk4

Packages only the native GTK4 client (`sonia-gtk4/`), built from the local
checkout. No downloads: everything is read from the repo above this folder.

## Build & install

```sh
cd sonia-gtk4/packaging
makepkg -si          # build + install with pacman
```

Rebuild after changing the app:

```sh
makepkg -sf && sudo pacman -U sonia-gtk4-*.pkg.tar.zst
```

## What gets installed

| Path | What |
|------|------|
| `/usr/lib/sonia-gtk4/` | app sources + `node_modules` (jsGTK) |
| `/usr/bin/sonia-gtk4` | launcher |
| `/usr/share/applications/sonia-gtk4.desktop` | menu entry |
| `/usr/share/icons/hicolor/256x256/apps/sonia-gtk4.png` | icon |
| `/etc/sonia-gtk4/env` | config (`HARNESS_URL`, `LOCALE`, …) |

Config for one user only: `~/.config/sonia-gtk4/env` (same keys, wins over
`/etc/sonia-gtk4/env`). Shell environment always wins over both.

## Note

The client does **not** start the harness. Run `bun run start`
in the sonia-assistant repo first, then launch `sonia-gtk4` (or the menu entry).
(`bun run start` is headless by default; `bun run webui` is the Chromium UI variant.)
