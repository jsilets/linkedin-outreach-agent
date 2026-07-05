#!/usr/bin/env bash
# Entrypoint for one account body (Fly Machine).
#
# Starts a virtual X display (Xvfb) so Chromium runs HEADFUL inside a headless
# container, then hands the process over to the account-runner. Headful matters:
# LinkedIn's client-side checks trip on headless signatures, so we render to a
# real (virtual) framebuffer instead of using --headless.
#
# The script traps signals and forwards them so Fly can suspend/stop the Machine
# cleanly, and it cleans up a stale X lock left by a previous crash/restart.

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

# Wait for the display to accept connections before launching the browser.
for _ in $(seq 1 50); do
  if xdpyinfo -display ":${DISPLAY_NUM}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

# Hand off to the runner as PID-adjacent process. exec so signals reach Node
# directly; the EXIT trap still tears Xvfb down when Node exits.
exec node /app/account-runner/dist/index.js
