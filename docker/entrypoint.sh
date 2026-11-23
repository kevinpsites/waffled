#!/bin/sh
# Volumes created by older images (or bind mounts) may be root-owned; fix them once,
# then run the app as the unprivileged node user.
set -eu

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data/media
  if [ "$(stat -c %U /data)" != "node" ] || [ "$(stat -c %U /data/media)" != "node" ]; then
    echo "entrypoint: setting /data ownership to node"
    chown -R node:node /data
  fi
  exec su-exec node "$@"
fi

exec "$@"
