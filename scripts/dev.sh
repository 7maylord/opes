#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_ENV="$ROOT_DIR/backend/.env"
BACKEND_COMPOSE="$ROOT_DIR/backend/docker-compose.yml"
BACKEND_PORT="${BACKEND_PORT:-3004}"
BACKEND_URL="${BACKEND_URL:-http://localhost:${BACKEND_PORT}}"
FRONTEND_PORT="${FRONTEND_PORT:-3005}"
BACKEND_ALLOWED_ORIGINS="${BACKEND_ALLOWED_ORIGINS:-http://localhost:${FRONTEND_PORT}}"
RUN_DOCKER=1
RUN_WORKER="${RUN_WORKER:-0}"

usage() {
  cat <<'EOF'
Usage: scripts/dev.sh [--skip-docker] [--worker]

Starts OPES locally for frontend testing:
  - PostgreSQL, Redis and MinIO through backend/docker-compose.yml
  - backend API directly in your terminal on http://localhost:3004
  - frontend directly in your terminal at http://localhost:3005

Options:
  --skip-docker  Do not start Docker services or run migrations.
  --worker       Also start the backend worker.

Environment overrides:
  BACKEND_PORT=4004 FRONTEND_PORT=4005 scripts/dev.sh
  BACKEND_ALLOWED_ORIGINS=http://localhost:4005 scripts/dev.sh
  RUN_WORKER=1 scripts/dev.sh
EOF
}

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      usage
      exit 0
      ;;
    --skip-docker)
      RUN_DOCKER=0
      ;;
    --worker)
      RUN_WORKER=1
      ;;
    *)
      echo "Unknown option: $arg"
      usage
      exit 1
      ;;
  esac
done

pids=()

terminate_tree() {
  local process_id="$1"
  local child_id
  for child_id in $(pgrep -P "$process_id" 2>/dev/null || true); do
    terminate_tree "$child_id"
  done
  kill "$process_id" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  if [ "${#pids[@]}" -gt 0 ]; then
    echo
    echo "Stopping OPES dev processes..."
    for pid in "${pids[@]}"; do
      terminate_tree "$pid"
    done
    wait "${pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

need_file() {
  if [ ! -f "$1" ]; then
    echo "Missing $1"
    echo "Create it from the matching .env.example first."
    exit 1
  fi
}

run_migrations() {
  echo "Running backend migrations..."
  DATABASE_URL="${MIGRATION_DATABASE_URL:-postgresql://opes:opes@localhost:5433/opes}" \
    pnpm --dir "$ROOT_DIR/backend" db:migrate
  docker compose -f "$BACKEND_COMPOSE" exec -T postgres \
    psql -U opes -d opes -v ON_ERROR_STOP=1 \
    < "$ROOT_DIR/backend/test/prepare-runtime-role.sql" >/dev/null
}

need_file "$BACKEND_ENV"

set -a
# shellcheck disable=SC1090
. "$BACKEND_ENV"
set +a

if [ "$RUN_DOCKER" = "1" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker not found; use --skip-docker if services are already running elsewhere."
    exit 1
  fi
  echo "Starting local PostgreSQL, Redis and MinIO..."
  docker compose -f "$BACKEND_COMPOSE" up -d
  run_migrations
else
  echo "Skipping Docker services and migrations."
fi

echo "Starting backend API on ${BACKEND_PORT}..."
PORT="$BACKEND_PORT" OPES_ALLOWED_ORIGINS="$BACKEND_ALLOWED_ORIGINS" \
  pnpm --dir "$ROOT_DIR/backend" start:dev &
pids+=("$!")

if [ "$RUN_WORKER" = "1" ]; then
  echo "Starting backend worker..."
  PORT="$BACKEND_PORT" OPES_ALLOWED_ORIGINS="$BACKEND_ALLOWED_ORIGINS" \
    pnpm --dir "$ROOT_DIR/backend" start:worker &
  pids+=("$!")
fi

echo "Starting frontend on ${FRONTEND_PORT}..."
NEXT_PUBLIC_OPES_API_URL="$BACKEND_URL" \
  pnpm --dir "$ROOT_DIR/frontend" dev --webpack --hostname 127.0.0.1 --port "$FRONTEND_PORT" &
pids+=("$!")

echo
echo "OPES local app is starting:"
echo "  Frontend: http://localhost:${FRONTEND_PORT}"
echo "  Backend:  ${BACKEND_URL}"
echo "  CORS:     ${BACKEND_ALLOWED_ORIGINS}"
echo
echo "Press Ctrl-C to stop everything."

while true; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      exit $?
    fi
  done
  sleep 1
done
