#!/bin/sh
# Hourly /traffic review as riotcoder (root cron on dev2, after the :07 traffic sync):
#   23 * * * * sh /home/anthony/www/nichedb.dev/app/ops/traffic-review/run.sh
# The evidence (nginx access logs, sshd journal) is root-only and never leaves the box:
# only the queued addresses' own requests are read, and only the decisions are written.
# Pass --dry-run to see the counts without writing.
set -eu
APP="${NICHEDB_APP:-nichedbdev-app-1}"
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="${TRAFFIC_REVIEW_LOG:-/var/log/nichedb-traffic-review.log}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
docker exec "$APP" bun apps/worker/src/traffic-review.js --pending > "$tmp/pending.txt"
python3 -I "$DIR/evidence.py" < "$tmp/pending.txt" > "$tmp/evidence.json" 2>> "$LOG"
out=$(docker exec -i "$APP" bun apps/worker/src/traffic-review.js "$@" < "$tmp/evidence.json")
echo "$(date -u +%FT%TZ) $out" >> "$LOG"
echo "$out"
