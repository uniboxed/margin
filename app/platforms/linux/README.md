# Margin for Linux (later)

Not started. Margin.app's Linux side goes here, as `macos/` and `windows/` hold theirs: what only Linux does (its
windows, overlays, keys, the web view for the host page). What every OS shares is in `app/shared/` (core, the
connector, which already writes the Chromium browsers' host files under `~/.config/`, and the host page).

Open question first (DECISIONS.md, the Windows plan): Wayland gives an app no way to place its own windows over
another app's, which Margin's overlays need; X11 does.
