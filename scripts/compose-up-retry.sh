#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-.env.example}"
COMPOSE_UP_RETRIES="${COMPOSE_UP_RETRIES:-1}"
COMPOSE_UP_RETRY_DELAY_SEC="${COMPOSE_UP_RETRY_DELAY_SEC:-30}"
COMPOSE_UP_NON_RETRYABLE_REGEX="${COMPOSE_UP_NON_RETRYABLE_REGEX:-yaml|no such file or directory|cannot locate specified dockerfile|unsupported config option|additional property|is not allowed|unknown service|invalid reference format|failed to read dockerfile}"

if ! [[ "$COMPOSE_UP_RETRIES" =~ ^[0-9]+$ ]]; then
  echo "COMPOSE_UP_RETRIES must be a non-negative integer"
  exit 1
fi

if ! [[ "$COMPOSE_UP_RETRY_DELAY_SEC" =~ ^[0-9]+$ ]]; then
  echo "COMPOSE_UP_RETRY_DELAY_SEC must be a non-negative integer"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[compose-up] docker daemon unavailable"
  exit 1
fi

echo "[compose-up] preflight: docker compose config"
if ! docker compose --env-file "$COMPOSE_ENV_FILE" config >/tmp/compose_up_config.out 2>/tmp/compose_up_config.err; then
  cat /tmp/compose_up_config.err >&2 || true
  echo "[compose-up] non-retryable: compose config check failed"
  exit 1
fi

attempt=1
max_attempts=$((COMPOSE_UP_RETRIES + 1))

while (( attempt <= max_attempts )); do
  attempt_log="$(mktemp)"
  echo "[compose-up] attempt ${attempt}/${max_attempts}"
  if docker compose --env-file "$COMPOSE_ENV_FILE" up -d --build >"$attempt_log" 2>&1; then
    cat "$attempt_log"
    rm -f "$attempt_log"
    echo "[compose-up] success"
    exit 0
  fi

  cat "$attempt_log" >&2 || true
  if [[ -n "$COMPOSE_UP_NON_RETRYABLE_REGEX" ]] && grep -Eqi "$COMPOSE_UP_NON_RETRYABLE_REGEX" "$attempt_log"; then
    rm -f "$attempt_log"
    echo "[compose-up] non-retryable error matched; stop retry"
    exit 1
  fi
  rm -f "$attempt_log"

  if (( attempt == max_attempts )); then
    echo "[compose-up] failed after ${max_attempts} attempt(s)"
    exit 1
  fi

  echo "[compose-up] failed, retry in ${COMPOSE_UP_RETRY_DELAY_SEC}s"
  sleep "$COMPOSE_UP_RETRY_DELAY_SEC"
  attempt=$((attempt + 1))
done
