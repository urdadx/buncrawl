#!/bin/sh
# Runs the server as the unprivileged `bun` user. Started as root, it first makes the data
# directory writable by that user: a bind-mounted host folder can be owned by any host user, and
# images before the switch to `bun` wrote it as root.
set -eu

if [ "$(id -u)" = "0" ]; then
  data=/data
  mkdir -p "$data"
  if [ -n "$(find "$data" \! -user bun -print -quit)" ]; then
    chown -R bun:bun "$data"
  fi
  # setpriv keeps the environment; give the server bun's home, not root's.
  export HOME=/home/bun USER=bun LOGNAME=bun
  exec setpriv --reuid=bun --regid=bun --init-groups -- "$@"
fi

exec "$@"
