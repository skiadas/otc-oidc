#!/usr/bin/env bash
set -euo pipefail

# Deploy script run on the server. Takes an image tag (default: latest).
# Takes a pre-upgrade snapshot of data + client config, then pulls and starts
# the new image. Rollback: docker compose up -d <previous-tag> after restoring
# the matching snapshot from ./backups.

TAG="${1:-latest}"
DIR="${DIR:-/opt/otc-oidc}"
cd "$DIR"

TS="$(date +%Y%m%d%H%M%S)"
mkdir -p backups

# Pre-upgrade snapshot (the risky moment is upgrades, so this is mandatory).
cp -r data "backups/data-$TS" 2>/dev/null || true
cp clients.json "backups/clients-$TS.json" 2>/dev/null || true

# Keep the last 15 snapshots.
ls -1dt backups/data-* 2>/dev/null | tail -n +16 | xargs -r rm -rf

export IMAGE_TAG="$TAG"
docker compose pull app
docker compose up -d
docker compose ps
