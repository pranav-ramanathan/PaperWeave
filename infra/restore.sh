#!/bin/sh
# Restore a backup made by infra/backup.sh into a database that exists and is empty.
# Usage: infra/restore.sh <file> <database>
# Then check the object store against it: pnpm --filter @paperweave/server check-blobs
set -eu
docker compose -f "$(dirname "$0")/compose.yaml" exec -T postgres \
  pg_restore --username paperweave --no-owner --exit-on-error --dbname "$2" < "$1"
echo "Restored $1 into $2."
