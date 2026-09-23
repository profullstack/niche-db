#!/usr/bin/env bash
#
# Full dress rehearsal on this machine, no Railway involved:
#   source  postgres:18 + wal_level=logical, loaded from a fixture
#           (make-fixture.sh: production schema + sample rows)
#   target  the real server/setup-server.sh (SKIP_SYSTEM=1, db only, port 15432)
#   run     schema -> subscribe -> copy -> indexes -> verify -> cutover
#           while a writer inserts/updates/deletes items on the source,
#           then asserts counts match, sequences continue, and the security
#           rules hold (TLS only, postgres only, anon locked out).
#
# usage: rehearse.sh <fixture-dir> [workdir]     KEEP=1 leaves it running
#
set -euo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
FIX=$(cd "${1:?usage: rehearse.sh <fixture-dir> [workdir]}" && pwd)
WORK=${2:-$(mktemp -d)}
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)
NET=nichedb-rehearsal
SRC=nichedb-rehearsal-src
SRCPW=rehearsal-source-pw
PORT=${PORT:-15432}

step() { printf '\n######## %s\n' "$*"; }
fail() { printf '\nREHEARSAL FAILED: %s\n' "$*" >&2; exit 1; }
src() { docker exec -i "$SRC" psql -U postgres -d railway -v ON_ERROR_STOP=1 -X -q -At "$@"; }
tgt() { docker exec -i supabase-db psql -h localhost -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -X -q -At "$@"; }

cleanup() {
  [ -n "${WRITER:-}" ] && kill "$WRITER" 2>/dev/null || true
  [ "${KEEP:-0}" = 1 ] && { echo "KEEP=1: left running (workdir $WORK)"; return; }
  (cd "$WORK/nichedb-supabase" 2>/dev/null && docker compose down -v >/dev/null 2>&1) || true
  docker rm -f "$SRC" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  # Postgres wrote the data dir as its own uid: remove it through Docker.
  docker run --rm -v "$WORK:/w" alpine:3 rm -rf /w/nichedb-supabase /w/state >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "source: postgres:18, wal_level=logical"
docker network create "$NET" >/dev/null 2>&1 || true
docker rm -f "$SRC" >/dev/null 2>&1 || true
docker run -d --name "$SRC" --network "$NET" -e POSTGRES_PASSWORD="$SRCPW" -e POSTGRES_DB=railway \
  postgres:18 -c wal_level=logical -c max_slot_wal_keep_size=1GB >/dev/null
for _ in $(seq 1 60); do docker exec "$SRC" pg_isready -U postgres -d railway >/dev/null 2>&1 && break; sleep 1; done
sleep 2

step "source: load fixture"
src < "$FIX/schema.sql" >/dev/null
docker exec -i -e PGOPTIONS='-c session_replication_role=replica' "$SRC" \
  psql -U postgres -d railway -v ON_ERROR_STOP=1 -X -q < "$FIX/small.sql" >/dev/null
docker exec -i -e PGOPTIONS='-c session_replication_role=replica' "$SRC" \
  psql -U postgres -d railway -v ON_ERROR_STOP=1 -X -q -c "copy items ($(cat "$FIX/items.columns")) from stdin" < "$FIX/items.copy"
# The fixture is a slice: drop rows whose FK parents were not copied, so the
# target can validate its foreign keys exactly as production will.
src <<'EOF'
do $$
declare r record; n bigint; total bigint;
begin
  loop
    total := 0;
    for r in
      select c.conrelid::regclass as child, c.confrelid::regclass as parent,
             (select string_agg('t.'||quote_ident(a.attname), ',' order by k.o) from unnest(c.conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n) as ccols,
             (select string_agg('p.'||quote_ident(a.attname), ',' order by k.o) from unnest(c.confkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n) as pcols
        from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace
    loop
      execute format('delete from %s t where row(%s) is not null and not exists (select 1 from %s p where row(%s) = row(%s))',
                     r.child, r.ccols, r.parent, r.pcols, r.ccols);
      get diagnostics n = row_count;
      total := total + n;
    end loop;
    exit when total = 0;
  end loop;
end $$;
select setval(pg_get_serial_sequence('items', 'id'), (select max(id) from items));
EOF
echo "source items: $(src -c 'select count(*) from items')"

step "target: setup-server.sh (rehearsal mode)"
# setup.sh pulls every Supabase image; the rehearsal only needs the db, so a
# PATH shim turns `docker compose pull` into a no-op.
mkdir -p "$WORK/bin"
REAL_DOCKER=$(command -v docker)
cat > "$WORK/bin/docker" <<EOF
#!/bin/sh
case "\$*" in *compose*pull*) exit 0 ;; esac
exec "$REAL_DOCKER" "\$@"
EOF
chmod +x "$WORK/bin/docker"
PATH="$WORK/bin:$PATH" SKIP_SYSTEM=1 ONLY_DB=1 WITH_PROXY=0 INSTALL_ROOT="$WORK" \
  DB_DOMAIN=localhost DB_PORT="$PORT" MEM_MB=4096 CPUS=4 \
  bash "$HERE/../server/setup-server.sh"
docker network connect "$NET" supabase-db 2>/dev/null || true

export SOURCE_MODE=docker SOURCE_CONTAINER=$SRC SOURCE_PASSWORD=$SRCPW
export TARGET_SSH=local TARGET_DIR=$WORK/nichedb-supabase STATE_DIR=$WORK/state
DB="$HERE/../nichedb-db"

step "orchestrator: fetch-connection, check, source-prep"
"$DB" fetch-connection
"$DB" check
"$DB" source-prep

step "orchestrator: schema"
"$DB" schema
[ "$(tgt -c "select count(*) from pg_tables where schemaname='public'")" = "$(src -c "select count(*) from pg_tables where schemaname='public'")" ] || fail "table count differs after schema"

step "writer: inserts/updates/deletes on the source for the whole run"
(
  while :; do
    src >/dev/null 2>&1 <<EOF || true
insert into items ($(sed 's/^id,//' "$FIX/items.columns"))
select $(sed -e 's/^id,//' -e 's/external_id/external_id || '"'"'-rh-'"'"' || gen_random_uuid()/' "$FIX/items.columns")
  from items order by random() limit 20;
update items set updated_at = now(), title = title || '.' where id in (select id from items order by random() limit 20);
delete from items where id in (select id from items where external_id like '%-rh-%' order by random() limit 5);
EOF
    sleep 0.3
  done
) &
WRITER=$!

step "orchestrator: subscribe + wait for the copy"
"$DB" subscribe
for _ in $(seq 1 120); do
  st=$(tgt -c "select string_agg(srsubstate::text||':'||n, ' ') from (select srsubstate, count(*) n from pg_subscription_rel group by 1) s")
  echo "  states: $st"
  case "$st" in r:*) [ "$(tgt -c "select count(*) from pg_subscription_rel where srsubstate <> 'r'")" = 0 ] && break ;; esac
  sleep 3
done
"$DB" status
[ "$(tgt -c "select count(*) from pg_subscription_rel where srsubstate <> 'r'")" = 0 ] || fail "initial copy never finished"

step "orchestrator: indexes (while the writer keeps going)"
"$DB" indexes
[ "$(tgt -c "select count(*) from pg_indexes where schemaname='public'")" = "$(src -c "select count(*) from pg_indexes where schemaname='public'")" ] || fail "index count differs"

step "orchestrator: verify (schema must be identical)"
"$DB" verify || fail "schema diff between source and target"

step "orchestrator: cutover (writer still running: it must start failing)"
"$DB" cutover --yes
sleep 2
kill "$WRITER" 2>/dev/null || true
WRITER=
[ "$(src -c "show default_transaction_read_only")" = on ] || fail "source is not read-only after cutover"
r=$(src -c "update items set title = title where id = (select max(id) from items)" 2>&1) && fail "source still accepts writes after cutover"
echo "  source write after cutover: rejected ($(cut -c1-70 <<<"$r"))"

step "assertions"
FULL=1 "$DB" verify 2>&1 | tee "$WORK/verify.txt"
grep -q DIFF "$WORK/verify.txt" && fail "row counts differ after cutover"
s=$(src -c "select count(*)||' '||max(id)||' '||md5(string_agg(id||title||updated_at, ',' order by id)) from items")
t=$(tgt -c "select count(*)||' '||max(id)||' '||md5(string_agg(id||title||updated_at, ',' order by id)) from items")
echo "  items source: $s"
echo "  items target: $t"
[ "$s" = "$t" ] || fail "items content differs"
[ "$(src -c "select md5(string_agg(search::text, ',' order by id)) from items")" = "$(tgt -c "select md5(string_agg(search::text, ',' order by id)) from items")" ] || fail "generated search column differs"
echo "  generated search column: identical"
# Sequences: a fresh insert on the target must not collide with a copied id.
tgt -c "insert into items (collection_id, source_id, external_id, title) select collection_id, source_id, 'rehearsal-after-cutover', 'x' from items limit 1 returning id" >/dev/null ||
  fail "insert after cutover failed (sequence not advanced?)"
echo "  insert after cutover: ok"
[ "$(tgt -c "select count(*) from pg_subscription")" = 0 ] || fail "subscription still present"
[ "$(src -c "select count(*) from pg_replication_slots")" = 0 ] || fail "slot left on the source"
echo "  subscription and slot gone"

step "security"
pg() { docker run --rm --network host -e PGCONNECT_TIMEOUT=5 postgres:18 psql "$1" -X -At -c "$2" 2>&1; }
PW=$(grep '^POSTGRES_PASSWORD=' "$WORK/nichedb-supabase/.env" | cut -d= -f2-)
r=$(pg "postgres://postgres:$PW@127.0.0.1:$PORT/postgres?sslmode=require" "select ssl from pg_stat_ssl where pid = pg_backend_pid()")
[ "$r" = t ] || fail "postgres over TLS: $r"
echo "  postgres over TLS: allowed"
r=$(pg "postgres://postgres:$PW@127.0.0.1:$PORT/postgres?sslmode=disable" "select 1") && fail "postgres without TLS was allowed"
echo "  postgres without TLS: rejected ($(tail -n1 <<<"$r" | cut -c1-90))"
r=$(pg "postgres://supabase_admin:$PW@127.0.0.1:$PORT/postgres?sslmode=require" "select 1") && fail "supabase_admin from outside was allowed"
echo "  supabase_admin from outside: rejected"
[ "$(tgt -c "select has_table_privilege('anon','public.items','select') or has_schema_privilege('anon','public','usage') or has_table_privilege('authenticated','public.items','select')")" = f ] ||
  fail "anon/authenticated can read nichedb tables"
echo "  anon/authenticated: no access to public"
# The app's own driver, with the URL shape the cutover sets.
APPURL="postgres://postgres:$PW@127.0.0.1:$PORT/postgres?sslmode=require"
r=$(DATABASE_URL="$APPURL" bun "$HERE/app-driver-check.js" 2>&1) || true
[ "$r" = "$(tgt -c 'select count(*) from items') true" ] || fail "app driver could not read the target over TLS: $r"
echo "  app driver (Bun SQL, sslmode=require): read ${r% *} items over TLS"

printf '\nREHEARSAL PASSED\n'
