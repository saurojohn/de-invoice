#!/bin/bash
# Tier 635b — pull an official image: from Docker Hub, or from one of its mirrors.
#
# The CI run starts PostgreSQL with `docker run postgres:16-alpine`. On
# 09.10.2026 Docker Hub answered the runner with "500 Internal Server Error"
# and then "toomanyrequests: You have reached your unauthenticated pull rate
# limit" — the limit of the runner's shared address, not of this repository —
# and both end-to-end jobs failed in their first minute, twice. The official
# images are also published, unchanged, on Amazon ECR Public (by Docker) and
# through Google's pull-through cache; whichever answers is tagged with the
# name the run uses.
#
#   usage: ci-pull-image.sh postgres:16-alpine
set -uo pipefail
IMG="${1:?image, e.g. postgres:16-alpine}"
if docker image inspect "$IMG" >/dev/null 2>&1; then echo "$IMG is already here"; exit 0; fi
for src in "$IMG" "public.ecr.aws/docker/library/$IMG" "mirror.gcr.io/library/$IMG"; do
  for try in 1 2 3; do
    if docker pull -q "$src" >/dev/null 2>"/tmp/ci-pull.err"; then
      [ "$src" = "$IMG" ] || docker tag "$src" "$IMG"
      echo "pulled $IMG from $src"
      exit 0
    fi
    echo "pull of $src failed (attempt $try): $(tail -1 /tmp/ci-pull.err | cut -c1-200)" >&2
    sleep $((try * 5))
  done
done
echo "could not pull $IMG from Docker Hub or its mirrors" >&2
exit 1
