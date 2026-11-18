#!/bin/sh
# Back up the database to a file. Usage: infra/backup.sh <database> <file>
# The object store is backed up by whoever hosts it; this is the half that is ours.
# Uses the Postgres of infra/compose.yaml. In production, run pg_dump against the real server
# with the same flags.
set -eu
docker compose -f "$(dirname "$0")/compose.yaml" exec -T postgres \
  pg_dump --username paperweave --format custom --no-owner "$1" > "$2"
echo "Backed up $1 to $2 ($(wc -c < "$2") bytes)."
