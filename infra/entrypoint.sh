#!/usr/bin/env bash
# Entrypoint for the single app container.
#
# Starts a virtual X display (Xvfb) so Chromium can run HEADFUL inside a
# headless container, then hands the process over to the runtime. Headful
# matters: LinkedIn's client-side checks trip on headless signatures, so we
# render to a real (virtual) framebuffer instead of using --headless.
#
# Real browser runs are a P0 item and are not yet wired, but the display is
# started unconditionally so the image is structurally correct for when they
# land. Xvfb is cheap when nothing draws to it.
#
# The script traps signals and forwards them so the host can stop the container
# cleanly, and it clears a stale X lock left by a previous crash/restart.

set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-99}"
SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1920x1080x24}"
XVFB_LOCK="/tmp/.X${DISPLAY_NUM}-lock"

xvfb_pid=""

cleanup() {
  # Forward the stop to Xvfb so we do not leak the process on restart.
  if [ -n "${xvfb_pid}" ] && kill -0 "${xvfb_pid}" 2>/dev/null; then
    kill "${xvfb_pid}" 2>/dev/null || true
    wait "${xvfb_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# A hard restart can leave the previous display lock behind, which makes Xvfb
# refuse to start on the same display number. Clear it if no server is live.
if [ -e "${XVFB_LOCK}" ]; then
  rm -f "${XVFB_LOCK}" || true
fi

# Start the virtual display in the background.
Xvfb ":${DISPLAY_NUM}" -screen 0 "${SCREEN_GEOMETRY}" -nolisten tcp -ac &
xvfb_pid=$!

export DISPLAY=":${DISPLAY_NUM}"

# Wait for the display to accept connections before launching anything.
for _ in $(seq 1 50); do
  if xdpyinfo -display ":${DISPLAY_NUM}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

# Hand off to the runtime. exec so signals reach Node directly; the EXIT trap
# still tears Xvfb down when Node exits. This is the proven production start
# command: compiled JS, no tsx.
exec node /app/runtime/dist/main.js
