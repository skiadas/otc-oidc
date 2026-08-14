#!/usr/bin/env bash
set -euo pipefail

# Poll body run on the server (e.g. hourly via cron). Refreshes the compose
# infrastructure files from the public repo, pulls the app image, and restarts
# only when its digest changed, so unchanged polls are no-ops.
# Rollback: IMAGE_TAG=<previous-sha> docker compose up -d

TAG="${1:-latest}"
DIR="${DIR:-/opt/otc-oidc}"
BRANCH="${BRANCH:-main}"
cd "$DIR"

# compose.yml resolves GHCR_OWNER from .env; mirror that here so the digest
# check inspects the same image the stack actually runs.
if [ -z "${GHCR_OWNER:-}" ] && [ -f .env ]; then
  GHCR_OWNER="$(sed -n 's/^GHCR_OWNER=//p' .env | head -1)"
fi
GHCR_OWNER="${GHCR_OWNER:-your-org}"

# No clone: keep the compose files themselves current from the public repo.
BASE="https://raw.githubusercontent.com/${GHCR_OWNER}/otc-oidc/${BRANCH}"
curl -fsSL "$BASE/compose.yml" -o compose.yml
curl -fsSL "$BASE/Caddyfile" -o Caddyfile

IMAGE="ghcr.io/${GHCR_OWNER}/otc-oidc"

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
