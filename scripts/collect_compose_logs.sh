#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-.env.example}"
OUT_DIR="${1:-${COMPOSE_LOG_DIR:-/tmp/compose-logs}}"
COMPOSE_EVENTS_SINCE="${COMPOSE_EVENTS_SINCE:-1h}"
COMPOSE_EVENTS_UNTIL="${COMPOSE_EVENTS_UNTIL:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"

mkdir -p "$OUT_DIR"

docker compose --env-file "$COMPOSE_ENV_FILE" ps -a >"${OUT_DIR}/ps.txt" 2>&1 || true
docker compose --env-file "$COMPOSE_ENV_FILE" logs --no-color >"${OUT_DIR}/services.log" 2>&1 || true
docker compose --env-file "$COMPOSE_ENV_FILE" images >"${OUT_DIR}/images.txt" 2>&1 || true
docker compose --env-file "$COMPOSE_ENV_FILE" config >"${OUT_DIR}/config.yml" 2>&1 || true
if command -v timeout >/dev/null 2>&1; then
  timeout 20s docker compose --env-file "$COMPOSE_ENV_FILE" events --json --since "$COMPOSE_EVENTS_SINCE" --until "$COMPOSE_EVENTS_UNTIL" >"${OUT_DIR}/events.jsonl" 2>&1 || true
else
  docker compose --env-file "$COMPOSE_ENV_FILE" events --json --since "$COMPOSE_EVENTS_SINCE" --until "$COMPOSE_EVENTS_UNTIL" >"${OUT_DIR}/events.jsonl" 2>&1 || true
fi

echo "[compose-logs] collected into ${OUT_DIR}"
