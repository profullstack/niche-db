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
# Three passes: the pending queue; riotcoder's own rejections, which only ever
# become approvals; and riotcoder's own approvals, which only ever come off when
# the address turns out to belong to a known owner (owners.js). That last pass
# decides on the address alone, so it skips reading the logs.
for pass in "" --rejected --approved; do
  if [ "$pass" = --approved ]; then
    echo '{}' > "$tmp/evidence.json"
  else
    docker exec "$APP" bun apps/worker/src/traffic-review.js $pass --pending > "$tmp/queue.txt"
    python3 -I "$DIR/evidence.py" < "$tmp/queue.txt" > "$tmp/evidence.json" 2>> "$LOG"
  fi
  out=$(docker exec -i "$APP" bun apps/worker/src/traffic-review.js $pass "$@" < "$tmp/evidence.json")
  echo "$(date -u +%FT%TZ) $out" >> "$LOG"
  echo "$out"
done
