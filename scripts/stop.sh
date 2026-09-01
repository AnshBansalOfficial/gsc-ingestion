#!/usr/bin/env bash
# Stops whatever start.sh launched, by port rather than by recorded PID:
# `exec` replaces the shell, but a build tool that forks (mvn spring-boot:run) leaves the
# real listener under a different PID, so the port is the reliable handle.
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a

for port in "${APP_PORT:-8080}" "${ORCHESTRATOR_PORT:-8090}"; do
  pids=$(ss -ltnp 2>/dev/null | grep ":${port} " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
  if [ -z "$pids" ]; then echo "port $port: nothing listening"; continue; fi
  for pid in $pids; do kill "$pid" 2>/dev/null && echo "port $port: stopped pid $pid"; done
done

sleep 2
for port in "${APP_PORT:-8080}" "${ORCHESTRATOR_PORT:-8090}"; do
  pids=$(ss -ltnp 2>/dev/null | grep ":${port} " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
  for pid in $pids; do kill -9 "$pid" 2>/dev/null && echo "port $port: force stopped pid $pid"; done
done
rm -f logs/*.pid
