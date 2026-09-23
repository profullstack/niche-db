#!/usr/bin/env bash
#
# Build a rehearsal fixture from production: the real schema, the small
# reference tables, and the newest ITEMS rows of items. Tables holding user
# credentials, sessions, emails or money are never copied.
#
# usage: make-fixture.sh <dir> [ITEMS=20000]
#
set -euo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
OUT=${1:?usage: make-fixture.sh <dir>}
ITEMS=${ITEMS:-20000}
mkdir -p "$OUT"
# Reuse the orchestrator's Railway transport (src_exec) without running main.
# shellcheck disable=SC1091
NICHEDB_DB_LIB=1 . "$HERE/../nichedb-db"

SMALL="collections sources feeds runs collection_stats data_dumps niches schema_migrations api_usage auto_place_cache contribution_tiers"

echo "schema" >&2
src_exec pg_dump -U postgres -d "$SOURCE_DB" --schema-only --no-owner --no-privileges > "$OUT/schema.sql"
echo "reference tables: $SMALL" >&2
args=()
for t in $SMALL; do args+=(-t "public.$t"); done
src_exec pg_dump -U postgres -d "$SOURCE_DB" --data-only --no-owner "${args[@]}" > "$OUT/small.sql"
echo "newest $ITEMS items" >&2
cols=$(src_q "select string_agg(quote_ident(column_name), ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'items' and is_generated = 'NEVER'")
printf '%s\n' "$cols" > "$OUT/items.columns"
src_exec psql -U postgres -d "$SOURCE_DB" -X -q -c "copy (select $cols from items order by id desc limit $ITEMS) to stdout" > "$OUT/items.copy"
wc -c "$OUT"/* >&2
