#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_ENV="$ROOT_DIR/backend/.env"
BACKEND_COMPOSE="$ROOT_DIR/backend/docker-compose.yml"
BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"
FRONTEND_PORT="${FRONTEND_PORT:-3001}"
RUN_DOCKER=1
RUN_WORKER="${RUN_WORKER:-0}"

usage() {
  cat <<'EOF'
Usage: scripts/dev.sh [--skip-docker] [--worker]

Starts OPES locally for frontend testing:
  - PostgreSQL, Redis and MinIO through backend/docker-compose.yml
  - backend API from backend/.env
  - frontend at http://localhost:3001 pointed at http://localhost:3000

Options:
  --skip-docker  Do not start Docker services or run migrations.
  --worker       Also start the backend worker.

Environment overrides:
  FRONTEND_PORT=3002 BACKEND_URL=http://localhost:3000 scripts/dev.sh
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

cleanup() {
  if [ "${#pids[@]}" -gt 0 ]; then
    echo
    echo "Stopping OPES dev processes..."
    kill "${pids[@]}" 2>/dev/null || true
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
  for file in "$ROOT_DIR"/backend/migrations/*.sql; do
    docker compose -f "$BACKEND_COMPOSE" exec -T postgres \
      psql -U opes -d opes -v ON_ERROR_STOP=1 < "$file" >/dev/null
  done
}

need_file "$BACKEND_ENV"

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

set -a
# shellcheck disable=SC1090
. "$BACKEND_ENV"
set +a

echo "Starting backend API on ${PORT:-3000}..."
pnpm --dir "$ROOT_DIR/backend" start:dev &
pids+=("$!")

if [ "$RUN_WORKER" = "1" ]; then
  echo "Starting backend worker..."
  pnpm --dir "$ROOT_DIR/backend" start:worker &
  pids+=("$!")
fi

echo "Starting frontend on ${FRONTEND_PORT}..."
NEXT_PUBLIC_OPES_API_URL="$BACKEND_URL" \
  pnpm --dir "$ROOT_DIR/frontend" dev --hostname 127.0.0.1 --port "$FRONTEND_PORT" &
pids+=("$!")

echo
echo "OPES local app is starting:"
echo "  Frontend: http://localhost:${FRONTEND_PORT}"
echo "  Backend:  ${BACKEND_URL}"
echo
echo "Press Ctrl-C to stop everything."

wait -n "${pids[@]}"
