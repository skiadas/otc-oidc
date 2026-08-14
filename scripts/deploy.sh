#!/usr/bin/env bash
set -euo pipefail

# Poll body run on the server (e.g. hourly via cron). Pulls the app image and
# restarts only when its digest changed, so unchanged polls are no-ops.
# Takes a pre-upgrade snapshot of data + client config before restarting.
# Rollback: IMAGE_TAG=<previous-sha> docker compose up -d after restoring the
# matching snapshot from ./backups.

TAG="${1:-latest}"
DIR="${DIR:-/opt/otc-oidc}"
cd "$DIR"

IMAGE="ghcr.io/${GHCR_OWNER:-your-org}/otc-oidc"

docker compose pull app

RUNNING="$(docker compose ps -q app | xargs -r docker inspect --format '{{.Image}}')"
PULLED="$(docker image inspect "$IMAGE:$TAG" --format '{{.Id}}')"
if [ -n "$RUNNING" ] && [ "$RUNNING" = "$PULLED" ]; then
  echo "image unchanged ($PULLED); nothing to do"
  exit 0
fi

TS="$(date +%Y%m%d%H%M%S)"
mkdir -p backups

# Pre-upgrade snapshot (the risky moment is upgrades, so this is mandatory).
cp -r data "backups/data-$TS" 2>/dev/null || true
cp clients.json "backups/clients-$TS.json" 2>/dev/null || true

# Keep the last 15 snapshots.
ls -1dt backups/data-* 2>/dev/null | tail -n +16 | xargs -r rm -rf

export IMAGE_TAG="$TAG"
docker compose up -d
docker compose ps
