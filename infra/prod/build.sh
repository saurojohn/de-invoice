#!/usr/bin/env bash
# Tier 828 — build the images with the code they are made of.
#
# `docker compose build` with GIT_COMMIT (the checked-out commit) and
# BUILD_TIME set: the backend reports both on „Systembetrieb", the frontend
# its own commit, so that after an update or a rollback the operator sees
# what the server runs — and whether backend and frontend are of one commit.
#
# Usage (from anywhere in the repository, on the server):
#   bash infra/prod/build.sh                  # all images
#   bash infra/prod/build.sh backend frontend
#   bash infra/prod/build.sh --no-cache backend
set -euo pipefail
cd "$(dirname "$0")/../.."
GIT_COMMIT=$(git rev-parse --short=12 HEAD 2>/dev/null || echo "")
if [[ -n "$GIT_COMMIT" ]] && ! git diff --quiet HEAD -- backend frontend 2>/dev/null; then
  echo "build.sh: backend/ or frontend/ differ from $GIT_COMMIT — the image is not exactly that commit" >&2
fi
BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
export GIT_COMMIT BUILD_TIME
echo "build.sh: commit ${GIT_COMMIT:-unknown}, $BUILD_TIME"
# shellcheck disable=SC2206
DC=(docker compose ${BUILD_COMPOSE_ARGS:--f infra/prod/docker-compose.yml})
exec "${DC[@]}" build "$@"
