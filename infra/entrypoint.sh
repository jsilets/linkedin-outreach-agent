#!/usr/bin/env bash
# Entrypoint for the single app container.
#
# Starts a virtual X display (Xvfb) so Chromium can run HEADFUL inside a
# headless container, then hands the process over to the runtime. Headful
# matters: LinkedIn's client-side checks trip on headless signatures, so we
# render to a real (virtual) framebuffer instead of using --headless.
#
# The display is started unconditionally; with LOA_EXECUTOR=real the runtime
# drives Chromium against it, and it is cheap when nothing draws to it.
#
# The script traps signals and forwards them so the host can stop the container
# cleanly, and it clears a stale X lock left by a previous crash/restart.

set -euo pipefail

# Platforms (Railway included) mount the /data volume owned by root, which masks
# the image's build-time chown. Fix ownership at runtime as root, then drop to
# the unprivileged app user for everything else. dumb-init (PID 1) forwards
# signals to gosu, which execs without forking, so signal handling is preserved.
# On the re-exec, id is the app user, so this block is skipped and boot proceeds.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data/vault /data/profile
  chown app:app /data /data/vault /data/profile
  exec gosu app "$0" "$@"
fi

DISPLAY_NUM="${DISPLAY_NUM:-99}"
SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1920x1080x24}"
XVFB_LOCK="/tmp/.X${DISPLAY_NUM}-lock"

xvfb_pid=""
runtime_pid=""
web_pid=""

cleanup() {
  # Forward the stop to every child so we do not leak processes on restart.
  for pid in "${web_pid}" "${runtime_pid}" "${xvfb_pid}"; do
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
    fi
  done
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

# Single-service deploy: the runtime worker (MCP + dispatch tick + real browser
# executor) runs in the background on MCP_PORT; the web UI + JSON API is the
# public face on PORT (8080). They share this container's /data volume, env, and
# COOKIE_VAULT_KEY, so an account linked through the UI is sealed into the same
# vault the executor reads. If either process exits, we exit too so the platform
# restarts the whole container (rather than limping on with half the system).
node /app/runtime/dist/main.js &
runtime_pid=$!

node --import tsx /app/web/server/src/main.ts &
web_pid=$!

# Wait for the first child to exit, then fall through to cleanup + exit.
wait -n "${runtime_pid}" "${web_pid}"
