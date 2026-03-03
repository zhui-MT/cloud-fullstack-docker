#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-.env.example}"
OUT_DIR="${1:-${COMPOSE_LOG_DIR:-/tmp/compose-logs}}"
COMPOSE_EVENTS_SINCE="${COMPOSE_EVENTS_SINCE:-1h}"
COMPOSE_EVENTS_UNTIL="${COMPOSE_EVENTS_UNTIL:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"
COMPOSE_LOG_MAX_FILE_BYTES="${COMPOSE_LOG_MAX_FILE_BYTES:-5242880}"
COMPOSE_LOG_TAIL_BYTES="${COMPOSE_LOG_TAIL_BYTES:-262144}"
COMPOSE_LOG_MAX_SERVICES_BYTES="${COMPOSE_LOG_MAX_SERVICES_BYTES:-${COMPOSE_LOG_MAX_FILE_BYTES}}"
COMPOSE_LOG_MAX_EVENTS_BYTES="${COMPOSE_LOG_MAX_EVENTS_BYTES:-${COMPOSE_LOG_MAX_FILE_BYTES}}"
COMPOSE_LOG_TAIL_SERVICES_BYTES="${COMPOSE_LOG_TAIL_SERVICES_BYTES:-${COMPOSE_LOG_TAIL_BYTES}}"
COMPOSE_LOG_TAIL_EVENTS_BYTES="${COMPOSE_LOG_TAIL_EVENTS_BYTES:-${COMPOSE_LOG_TAIL_BYTES}}"

validate_non_negative() {
  local name="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "${name} must be a non-negative integer"
    exit 1
  fi
}

trim_file_if_large() {
  local file_path="$1"
  local max_bytes="$2"
  local tail_bytes="$3"
  if [[ ! -f "$file_path" ]]; then
    return 0
  fi

  local size_bytes
  size_bytes="$(wc -c <"$file_path" | tr -d '[:space:]')"
  if [[ -z "$size_bytes" ]]; then
    return 0
  fi

  if (( size_bytes <= max_bytes )); then
    return 0
  fi

  if (( tail_bytes > size_bytes )); then
    tail_bytes="${size_bytes}"
  fi

  local tmp_file
  tmp_file="$(mktemp)"
  {
    echo "[compose-logs] truncated: ${file_path}"
    echo "[compose-logs] original_bytes=${size_bytes}, kept_tail_bytes=${tail_bytes}, max_bytes=${max_bytes}"
    echo
    tail -c "$tail_bytes" "$file_path"
  } >"$tmp_file"
  mv "$tmp_file" "$file_path"
}

file_sha256() {
  local file_path="$1"
  if [[ ! -f "$file_path" ]]; then
    printf 'missing'
    return 0
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{print $1}'
    return 0
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | awk '{print $1}'
    return 0
  fi

  printf 'unavailable'
}

validate_non_negative "COMPOSE_LOG_MAX_FILE_BYTES" "$COMPOSE_LOG_MAX_FILE_BYTES"
validate_non_negative "COMPOSE_LOG_TAIL_BYTES" "$COMPOSE_LOG_TAIL_BYTES"
validate_non_negative "COMPOSE_LOG_MAX_SERVICES_BYTES" "$COMPOSE_LOG_MAX_SERVICES_BYTES"
validate_non_negative "COMPOSE_LOG_MAX_EVENTS_BYTES" "$COMPOSE_LOG_MAX_EVENTS_BYTES"
validate_non_negative "COMPOSE_LOG_TAIL_SERVICES_BYTES" "$COMPOSE_LOG_TAIL_SERVICES_BYTES"
validate_non_negative "COMPOSE_LOG_TAIL_EVENTS_BYTES" "$COMPOSE_LOG_TAIL_EVENTS_BYTES"

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

trim_file_if_large "${OUT_DIR}/services.log" "$COMPOSE_LOG_MAX_SERVICES_BYTES" "$COMPOSE_LOG_TAIL_SERVICES_BYTES"
trim_file_if_large "${OUT_DIR}/events.jsonl" "$COMPOSE_LOG_MAX_EVENTS_BYTES" "$COMPOSE_LOG_TAIL_EVENTS_BYTES"

{
  echo "COMPOSE_LOG_MAX_FILE_BYTES=${COMPOSE_LOG_MAX_FILE_BYTES}"
  echo "COMPOSE_LOG_TAIL_BYTES=${COMPOSE_LOG_TAIL_BYTES}"
  echo "COMPOSE_LOG_MAX_SERVICES_BYTES=${COMPOSE_LOG_MAX_SERVICES_BYTES}"
  echo "COMPOSE_LOG_MAX_EVENTS_BYTES=${COMPOSE_LOG_MAX_EVENTS_BYTES}"
  echo "COMPOSE_LOG_TAIL_SERVICES_BYTES=${COMPOSE_LOG_TAIL_SERVICES_BYTES}"
  echo "COMPOSE_LOG_TAIL_EVENTS_BYTES=${COMPOSE_LOG_TAIL_EVENTS_BYTES}"
  for file_name in ps.txt services.log images.txt config.yml events.jsonl; do
    file_path="${OUT_DIR}/${file_name}"
    if [[ -f "$file_path" ]]; then
      bytes="$(wc -c <"$file_path" | tr -d '[:space:]')"
      sha="$(file_sha256 "$file_path")"
      echo "${file_name}: bytes=${bytes} sha256=${sha}"
    else
      echo "${file_name}: missing"
    fi
  done
} >"${OUT_DIR}/manifest.txt"

echo "[compose-logs] collected into ${OUT_DIR}"
