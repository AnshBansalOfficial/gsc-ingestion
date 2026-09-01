#!/usr/bin/env bash
# Starts the Java service and the orchestrator in the background.
# Logs go to logs/, PIDs to logs/*.pid. Stop them with scripts/stop.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

[ -f .env ] || { echo "No .env — copy .env.example and fill it in."; exit 1; }
set -a; . ./.env; set +a
mkdir -p logs

start() {  # name, port, working dir, command...
  local name=$1 port=$2 dir=$3; shift 3
  if ss -ltn 2>/dev/null | grep -q ":${port} "; then
    # Already running: leave it alone and let the readiness check below confirm it.
    echo "  $name: already listening on $port, leaving it running"; return 0
  fi
  ( cd "$dir" && exec "$@" ) > "$ROOT/logs/$name.log" 2>&1 &
  echo $! > "$ROOT/logs/$name.pid"
  echo "  $name: pid $(cat "$ROOT/logs/$name.pid"), log logs/$name.log"
}

echo "starting services"
start app "${APP_PORT:-8080}" "$ROOT/demo-app" mvn -B -q spring-boot:run
start orchestrator "${ORCHESTRATOR_PORT:-8090}" "$ROOT/orchestrator" node src/index.js

printf 'waiting for both to come up'
for _ in $(seq 1 90); do
  if curl -fsS --max-time 2 "http://localhost:${APP_PORT:-8080}/api/health" >/dev/null 2>&1 \
  && curl -fsS --max-time 2 "http://localhost:${ORCHESTRATOR_PORT:-8090}/health" >/dev/null 2>&1; then
    echo; echo "ready — open http://localhost:${APP_PORT:-8080}"; exit 0
  fi
  printf '.'; sleep 1
done
echo; echo "timed out. Check logs/app.log and logs/orchestrator.log"; exit 1
