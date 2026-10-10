#!/bin/sh
# Tier 654 — the backend container's entrypoint.
#
# The image runs as `app`. Two cases need a word:
#
#   1. The container was started as root (`--user root`): the storage
#      directory is handed to `app` and the program runs as `app` all the
#      same. That is also how a volume an image from before Tier 654 left
#      root-owned is brought over, once:
#        docker compose -f infra/prod/docker-compose.yml run --rm --user root \
#          --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
#          --cap-add SETUID --cap-add SETGID backend true
#      (the compose file drops every capability; this one run needs these.)
#
#   2. The storage directory cannot be written: said here, in words, before
#      the first upload fails with EACCES somewhere inside a request.
set -e
dir="${STORAGE_PATH:-/data/invoice-system}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$dir"
  chown -R app:app "$dir"
  exec setpriv --reuid=app --regid=app --init-groups "$@"
fi
if ! [ -d "$dir" ] || ! [ -w "$dir" ]; then
  echo "de-invoice: $dir is not writable by $(id -un) (uid $(id -u))." >&2
  echo "de-invoice: a volume from an image before Tier 654 belongs to root — hand it over once:" >&2
  echo "de-invoice:   docker compose run --rm --user root --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --cap-add SETUID --cap-add SETGID backend true" >&2
  exit 1
fi
exec "$@"
