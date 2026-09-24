#!/usr/bin/env bash
#
# Stand up self-hosted Supabase for nichedb on a fresh Ubuntu/Debian box.
# Run as root ON THE DATABASE SERVER. Idempotent: a second run keeps the
# generated secrets, certificate and data, and only rewrites the nichedb
# overlay (tuning, pg_hba, compose override) before restarting the stack.
#
# What it does:
#   1. System: base packages, Docker log rotation, ufw (ssh + 80/443 + Postgres)
#   2. Supabase: official setup.sh at a pinned self-hosted release tag
#   3. .env: public URLs, signups off, compose overrides (Caddy + nichedb)
#   4. Postgres: self-signed TLS cert, pg_hba that only lets `postgres` in from
#      outside and only over TLS, tuning sized from this box's RAM and CPUs
#   5. Start the stack, then take nichedb's tables away from the anon and
#      authenticated roles so PostgREST can never serve them
#   6. Write nichedb-connection.env (0600) with the app's DATABASE_URL
#
# Knobs (environment variables):
#   SUPABASE_REF   self-hosted/v0.8.2         pinned release of supabase/docker
#   INSTALL_ROOT   /opt                       parent of the project directory
#   PROJECT        nichedb-supabase           project directory name
#   DB_DOMAIN      $(hostname -f)             Postgres host name (cert SAN)
#   STUDIO_DOMAIN  = DB_DOMAIN                Studio + API over Caddy HTTPS
#   SITE_URL       https://nichedb.dev
#   DB_PORT        5432                       public Postgres port on the host
#   PGDATA_DIR     (project)/volumes/db/data  put PGDATA on a separate disk
#   MEM_MB / CPUS  detected                   override the tuning inputs
#   WITH_PROXY     1                          0 = no Caddy (no 80/443)
#   SKIP_SYSTEM    0                          1 = no apt/ufw/docker (rehearsal)
#   ONLY_DB        0                          1 = start only the db service
#
set -euo pipefail

SUPABASE_REF=${SUPABASE_REF:-self-hosted/v0.8.2}
INSTALL_ROOT=${INSTALL_ROOT:-/opt}
PROJECT=${PROJECT:-nichedb-supabase}
# The server's own name: the app connects to the box it already knows.
DB_DOMAIN=${DB_DOMAIN:-$(hostname -f 2>/dev/null || hostname)}
STUDIO_DOMAIN=${STUDIO_DOMAIN:-$DB_DOMAIN}
SITE_URL=${SITE_URL:-https://nichedb.dev}
DB_PORT=${DB_PORT:-5432}
PGDATA_DIR=${PGDATA_DIR:-}
# Fixed subnet for the compose network, so pg_hba can tell the gateway (where
# Docker's userland proxy makes outside clients appear) from real services.
DOCKER_SUBNET=${DOCKER_SUBNET:-172.31.250.0/24}
DOCKER_GATEWAY=${DOCKER_GATEWAY:-172.31.250.1}
WITH_PROXY=${WITH_PROXY:-1}
SKIP_SYSTEM=${SKIP_SYSTEM:-0}
ONLY_DB=${ONLY_DB:-0}

DIR="$INSTALL_ROOT/$PROJECT"
PG_UID=100 # postgres inside supabase/postgres:17.6.1.x
PG_GID=101

log() { printf '\n===> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$SKIP_SYSTEM" = 1 ] || [ "$(id -u)" = 0 ] || die "run as root (or SKIP_SYSTEM=1 for a rehearsal)"

# ---------------------------------------------------------------- 1. system
backup() { # never overwrite without a numbered copy beside the original
  local f=$1 n=1 dir name base ext
  [ -e "$f" ] || return 0
  dir=$(dirname "$f")
  name=$(basename "$f")
  if [[ "${name#.}" == *.* ]]; then base=${name%.*} ext=".${name##*.}"; else base=$name ext=""; fi
  while [ -e "$dir/$base.bak-$(printf %03d $n)$ext" ]; do n=$((n + 1)); done
  cp -a "$f" "$dir/$base.bak-$(printf %03d $n)$ext"
}

ssh_ports() {
  ss -ltnpH 2>/dev/null | awk '/"sshd"/ {n=split($4,a,":"); print a[n]}' | sort -u
}

system_setup() {
  log "Base packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -qq -y curl ca-certificates openssl jq ufw >/dev/null

  log "Docker log rotation"
  mkdir -p /etc/docker
  if [ ! -s /etc/docker/daemon.json ]; then
    printf '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "50m", "max-file": "3" }\n}\n' > /etc/docker/daemon.json
  elif ! grep -q max-size /etc/docker/daemon.json; then
    warn "/etc/docker/daemon.json exists without log rotation; left untouched"
  fi

  log "Firewall"
  local p ports
  ports=$(ssh_ports)
  [ -n "$ports" ] || ports=22
  for p in $ports; do ufw allow "$p/tcp" >/dev/null; done
  ufw allow "$DB_PORT/tcp" >/dev/null
  if [ "$WITH_PROXY" = 1 ]; then
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    ufw allow 443/udp >/dev/null
  fi
  ufw --force enable >/dev/null
  # Docker publishes ports through its own iptables chains, ahead of ufw, so
  # the rules above document intent; the real gate for 5432 is pg_hba + TLS.
  ufw status | sed 's/^/    /'
}

# ------------------------------------------------------------- 2. supabase
supabase_setup() {
  mkdir -p "$INSTALL_ROOT"
  if [ -f "$DIR/.env" ] && [ -f "$DIR/docker-compose.yml" ]; then
    log "Supabase project already at $DIR; keeping its secrets"
    return
  fi
  log "Supabase $SUPABASE_REF into $DIR"
  local tmp
  tmp=$(mktemp -d)
  curl -fsSL "https://raw.githubusercontent.com/supabase/supabase/$SUPABASE_REF/docker/setup.sh" -o "$tmp/setup.sh"
  local flags=(--ref "$SUPABASE_REF" -p "$PROJECT" -y)
  [ "$SKIP_SYSTEM" = 1 ] && flags+=(--skip-deps)
  # setup.sh prints every generated secret; keep that off the terminal (and
  # out of whatever ssh session is watching) in a root-only log instead.
  local slog="$INSTALL_ROOT/$PROJECT-setup.log"
  (umask 077 && : > "$slog")
  if ! (cd "$INSTALL_ROOT" && sh "$tmp/setup.sh" "${flags[@]}") >> "$slog" 2>&1; then
    grep -E '^(===>|ERROR|WARNING)' "$slog" | tail -n 20 >&2
    die "Supabase setup.sh failed; full log (contains secrets): $slog"
  fi
  grep -E '^===>' "$slog" | grep -v -i 'key\|secret' | sed 's/^/    /' || true
  rm -rf "$tmp"
}

set_env() { # set_env KEY VALUE  -> replace or append in $DIR/.env
  local k=$1 v=$2
  if grep -q "^$k=" "$DIR/.env"; then
    sed -i "s|^$k=.*$|$k=$v|" "$DIR/.env"
  else
    printf '%s=%s\n' "$k" "$v" >> "$DIR/.env"
  fi
}
get_env() { grep "^$1=" "$DIR/.env" | head -n1 | cut -d= -f2-; }

configure_env() {
  log "Configuring .env"
  backup "$DIR/.env"
  set_env SUPABASE_PUBLIC_URL "https://$STUDIO_DOMAIN"
  set_env API_EXTERNAL_URL "https://$STUDIO_DOMAIN/auth/v1"
  set_env SITE_URL "$SITE_URL"
  set_env PROXY_DOMAIN "$STUDIO_DOMAIN"
  set_env CERTBOT_EMAIL "admin@${DB_DOMAIN#*.}"
  set_env POOLER_TENANT_ID nichedb
  set_env STUDIO_DEFAULT_ORGANIZATION "Profullstack"
  set_env STUDIO_DEFAULT_PROJECT "nichedb"
  # nichedb authenticates its own users; GoTrue must not hand out accounts.
  set_env DISABLE_SIGNUP true
  set_env ENABLE_ANONYMOUS_USERS false
  local files=docker-compose.yml
  [ "$WITH_PROXY" = 1 ] && files="$files:docker-compose.caddy.yml"
  files="$files:docker-compose.nichedb.yml"
  set_env COMPOSE_FILE "$files"
  chmod 600 "$DIR/.env"
}

# --------------------------------------------------------------- 4. postgres
detect_resources() {
  MEM_MB=${MEM_MB:-$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)}
  CPUS=${CPUS:-$(nproc)}
}

write_tls() {
  local tls="$DIR/volumes/nichedb/tls"
  mkdir -p "$tls"
  if [ ! -s "$tls/server.key" ]; then
    log "Self-signed TLS certificate for $DB_DOMAIN (10 years)"
    openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
      -days 3650 -subj "/CN=$DB_DOMAIN" -addext "subjectAltName=DNS:$DB_DOMAIN" \
      -keyout "$tls/server.key" -out "$tls/server.crt" 2>/dev/null
  fi
  if [ -O "$tls/server.key" ]; then
    chmod 600 "$tls/server.key"
    chmod 644 "$tls/server.crt"
  fi
  if [ "$(id -u)" = 0 ]; then
    chown "$PG_UID:$PG_GID" "$tls/server.key" "$tls/server.crt"
  elif [ -O "$tls/server.key" ]; then
    # Rehearsal as a normal user: the key must still belong to the container's postgres.
    docker run --rm -v "$tls:/tls" --entrypoint /bin/chown alpine:3 "$PG_UID:$PG_GID" /tls/server.key /tls/server.crt
  fi
}

write_pg_hba() {
  cat > "$DIR/volumes/nichedb/pg_hba.conf" <<EOF
# nichedb: managed by ops/selfhost-supabase/server/setup-server.sh
# Inside the container.
local   all  supabase_admin                          trust
local   all  all                                     peer map=supabase_map
host    all  all            127.0.0.1/32             trust
host    all  all            ::1/128                  trust
# The compose network's gateway is where outside clients show up whenever
# Docker proxies a published port (localhost, IPv6). Treat it as the internet.
hostssl all  postgres       ${DOCKER_GATEWAY}/32     scram-sha-256
host    all  all            ${DOCKER_GATEWAY}/32     reject
# The Supabase services on the compose network.
host    all  all            ${DOCKER_SUBNET}         scram-sha-256
# The internet: only the app's role, only over TLS.
hostssl all  postgres       0.0.0.0/0                scram-sha-256
hostssl all  postgres       ::/0                     scram-sha-256
host    all  all            0.0.0.0/0                reject
host    all  all            ::/0                     reject
EOF
}

write_tuning() {
  detect_resources
  local sb=$((MEM_MB / 4)) ecs=$((MEM_MB * 7 / 10))
  local mwm=$((MEM_MB / 16)); [ $mwm -gt 2048 ] && mwm=2048
  local half=$((CPUS / 2)); [ $half -lt 1 ] && half=1; [ $half -gt 4 ] && half=4
  log "Postgres tuning for ${MEM_MB} MB RAM, ${CPUS} CPUs"
  cat > "$DIR/volumes/nichedb/nichedb.conf" <<EOF
# nichedb: managed by ops/selfhost-supabase/server/setup-server.sh
# Sized for ${MEM_MB} MB RAM / ${CPUS} CPUs. Loaded last from conf.d, so it wins.
hba_file = '/etc/nichedb/pg_hba.conf'
ssl = on
ssl_cert_file = '/etc/nichedb/tls/server.crt'
ssl_key_file = '/etc/nichedb/tls/server.key'

max_connections = 200
shared_buffers = ${sb}MB
effective_cache_size = ${ecs}MB
maintenance_work_mem = ${mwm}MB
work_mem = 32MB
wal_buffers = 64MB
max_wal_size = 16GB
min_wal_size = 2GB
checkpoint_timeout = 15min
checkpoint_completion_target = 0.9
random_page_cost = 1.1
effective_io_concurrency = 200

max_worker_processes = $((CPUS + 8))
max_parallel_workers = ${CPUS}
max_parallel_workers_per_gather = ${half}
max_parallel_maintenance_workers = ${half}

# Room for the migration subscription (and Realtime's own slot).
max_replication_slots = 10
max_logical_replication_workers = 8
max_sync_workers_per_subscription = 4

# items is 35M+ rows and rewritten constantly by the crawlers.
autovacuum_max_workers = 4
autovacuum_vacuum_scale_factor = 0.05
autovacuum_analyze_scale_factor = 0.02
autovacuum_vacuum_cost_limit = 2000
EOF
}

write_overlay() {
  local shm=$((MEM_MB / 8)); [ $shm -lt 256 ] && shm=256
  {
    echo "# nichedb: managed by ops/selfhost-supabase/server/setup-server.sh"
    echo "services:"
    echo "  db:"
    echo "    shm_size: ${shm}m"
    echo "    ports:"
    echo "      - \"${DB_PORT}:5432\""
    echo "    volumes:"
    [ -n "$PGDATA_DIR" ] && echo "      - ${PGDATA_DIR}:/var/lib/postgresql/data:Z"
    echo "      - ./volumes/nichedb/nichedb.conf:/etc/postgresql-custom/conf.d/zz-nichedb.conf:ro,z"
    echo "      - ./volumes/nichedb/pg_hba.conf:/etc/nichedb/pg_hba.conf:ro,z"
    echo "      - ./volumes/nichedb/tls:/etc/nichedb/tls:ro,z"
    echo "  supavisor:"
    echo "    # The db itself owns the public 5432; the pooler stays on loopback."
    echo "    ports: !override"
    echo "      - \"127.0.0.1:\${POOLER_PROXY_PORT_TRANSACTION}:6543\""
    echo "networks:"
    echo "  default:"
    echo "    ipam:"
    echo "      config:"
    echo "        - subnet: ${DOCKER_SUBNET}"
    echo "          gateway: ${DOCKER_GATEWAY}"
  } > "$DIR/docker-compose.nichedb.yml"
  if [ -n "$PGDATA_DIR" ]; then
    mkdir -p "$PGDATA_DIR"
  fi
}

# ------------------------------------------------------------------ 5. start
compose() { (cd "$DIR" && docker compose "$@"); }

start_stack() {
  log "Starting the stack"
  if [ "$ONLY_DB" = 1 ]; then
    compose up -d --wait db
  else
    compose up -d --wait
  fi
  # A config change on an already-running db needs a restart to take effect.
  compose restart db >/dev/null

  for _ in $(seq 1 60); do
    docker exec supabase-db pg_isready -U postgres -h localhost >/dev/null 2>&1 && break
    sleep 2
  done
}

sql_admin() { docker exec -i supabase-db psql -U supabase_admin -h localhost -d postgres -v ON_ERROR_STOP=1 -X -q -At "$@"; }

lock_down_public() {
  log "Keeping nichedb's tables away from PostgREST's anon/authenticated roles"
  sql_admin <<'EOF'
-- Supabase grants anon/authenticated everything new in public by default.
-- nichedb serves its own API and never uses PostgREST, so take it all back.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role supabase_admin in schema public revoke all on tables from anon, authenticated;
alter default privileges for role supabase_admin in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role supabase_admin in schema public revoke all on functions from anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
-- USAGE (and EXECUTE on functions) also reach anon through PUBLIC. Only the
-- app's role and service_role get into the schema at all.
revoke usage on schema public from public, anon, authenticated;
grant usage on schema public to postgres, service_role;
EOF
}

check_postgres() {
  log "Checks"
  sql_admin -c "select 'ssl='||current_setting('ssl')||' shared_buffers='||current_setting('shared_buffers')||' hba='||current_setting('hba_file')||' version='||current_setting('server_version')"
  local anon
  anon=$(sql_admin -c "select has_schema_privilege('anon','public','usage') or has_schema_privilege('authenticated','public','usage')")
  [ "$anon" = f ] || die "anon/authenticated can still use schema public"
  echo "anon/authenticated locked out of schema public"
  df -h "${PGDATA_DIR:-$DIR/volumes/db/data}" | tail -1 | awk '{print "data disk: "$4" free of "$2}'
}

write_connection() {
  local pw
  pw=$(get_env POSTGRES_PASSWORD)
  umask 077
  cat > "$DIR/nichedb-connection.env" <<EOF
# nichedb app connection (written by setup-server.sh). Keep secret.
SELFHOST_DATABASE_URL=postgres://postgres:${pw}@${DB_DOMAIN}:${DB_PORT}/postgres?sslmode=require
SELFHOST_DB_DOMAIN=${DB_DOMAIN}
SELFHOST_DB_PORT=${DB_PORT}
SELFHOST_STUDIO_URL=https://${STUDIO_DOMAIN}
SELFHOST_DASHBOARD_USERNAME=$(get_env DASHBOARD_USERNAME)
SELFHOST_DASHBOARD_PASSWORD=$(get_env DASHBOARD_PASSWORD)
SELFHOST_POSTGRES_PASSWORD=${pw}
SELFHOST_ANON_KEY=$(get_env ANON_KEY)
SELFHOST_SERVICE_ROLE_KEY=$(get_env SERVICE_ROLE_KEY)
SELFHOST_SUPABASE_REF=${SUPABASE_REF}
EOF
  log "Wrote $DIR/nichedb-connection.env"
}

# ------------------------------------------------------------------- main
[ "$SKIP_SYSTEM" = 1 ] || system_setup
supabase_setup
mkdir -p "$DIR/volumes/nichedb"
configure_env
write_tls
write_pg_hba
write_tuning
write_overlay
start_stack
lock_down_public
check_postgres
write_connection
log "Done. Supabase for nichedb is up in $DIR"
