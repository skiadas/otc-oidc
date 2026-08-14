#!/usr/bin/env bash
set -euo pipefail

# Poll body run on the server (e.g. hourly via cron). Pulls the app image and
# restarts only when its digest changed, so unchanged polls are no-ops.
# Rollback: IMAGE_TAG=<previous-sha> docker compose up -d

TAG="${1:-latest}"
DIR="${DIR:-/opt/otc-oidc}"
cd "$DIR"

# compose.yml resolves GHCR_OWNER from .env; mirror that here so the digest
# check inspects the same image the stack actually runs.
if [ -z "${GHCR_OWNER:-}" ] && [ -f .env ]; then
  GHCR_OWNER="$(sed -n 's/^GHCR_OWNER=//p' .env | head -1)"
fi

IMAGE="ghcr.io/${GHCR_OWNER:-your-org}/otc-oidc"

docker compose pull app

RUNNING="$(docker compose ps -q app | xargs -r docker inspect --format '{{.Image}}')"
PULLED="$(docker image inspect "$IMAGE:$TAG" --format '{{.Id}}')"
if [ -n "$RUNNING" ] && [ "$RUNNING" = "$PULLED" ]; then
  echo "image unchanged ($PULLED); nothing to do"
  exit 0
fi

export IMAGE_TAG="$TAG"
docker compose up -d
docker compose ps
