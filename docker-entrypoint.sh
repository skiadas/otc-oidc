#!/bin/sh
set -e

# The data dir is a host bind mount, so its ownership is unknown at image
# build time. Run as root to (re)own it for the node user, then drop to node.
mkdir -p /app/data
chown -R node:node /app/data

exec su-exec node node dist/index.js
