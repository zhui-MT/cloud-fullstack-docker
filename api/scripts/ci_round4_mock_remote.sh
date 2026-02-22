#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$API_DIR/.." && pwd)"
API_PORT="${API_PORT:-4101}"
MOCK_R_ENGINE_PORT="${MOCK_R_ENGINE_PORT:-8001}"
MOCK_R_ENGINE_HOST="${MOCK_R_ENGINE_HOST:-127.0.0.1}"
LOG_DIR="${LOG_DIR:-$(mktemp -d)}"
API_LOG="$LOG_DIR/api.log"
MOCK_LOG="$LOG_DIR/mock-r-engine.log"
mkdir -p "$LOG_DIR"

wait_http_ok() {
  local url="$1"
  local retries="${2:-80}"
  local delay="${3:-0.25}"
  for _ in $(seq 1 "$retries"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

cleanup() {
  local code=$?
  if [[ -n "${API_PID:-}" ]] && kill -0 "$API_PID" >/dev/null 2>&1; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${MOCK_PID:-}" ]] && kill -0 "$MOCK_PID" >/dev/null 2>&1; then
    kill "$MOCK_PID" >/dev/null 2>&1 || true
    wait "$MOCK_PID" >/dev/null 2>&1 || true
  fi
  if [[ $code -ne 0 ]]; then
    echo "ci_round4_mock_remote.sh failed (exit=$code)"
    echo "logs: $LOG_DIR"
    [[ -f "$MOCK_LOG" ]] && { echo "--- mock-r-engine.log ---"; cat "$MOCK_LOG"; }
    [[ -f "$API_LOG" ]] && { echo "--- api.log ---"; cat "$API_LOG"; }
  fi
  exit "$code"
}
trap cleanup EXIT

echo "start mock-r-engine on ${MOCK_R_ENGINE_HOST}:${MOCK_R_ENGINE_PORT}"
MOCK_R_ENGINE_PORT="$MOCK_R_ENGINE_PORT" MOCK_R_ENGINE_HOST="$MOCK_R_ENGINE_HOST" \
  node "$SCRIPT_DIR/mock_r_engine.js" >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!

if ! wait_http_ok "http://${MOCK_R_ENGINE_HOST}:${MOCK_R_ENGINE_PORT}/health" 80 0.25; then
  echo "mock-r-engine health check failed"
  exit 1
fi

echo "start api on 127.0.0.1:${API_PORT}"
(
  cd "$API_DIR"
  API_PORT="$API_PORT" \
    JOB_QUEUE_MODE=memory \
    JOB_STORE_MODE=memory \
    R_ENGINE_URL="http://${MOCK_R_ENGINE_HOST}:${MOCK_R_ENGINE_PORT}" \
    R_ENGINE_LOCAL_DISABLE=1 \
    npm run start
) >"$API_LOG" 2>&1 &
API_PID=$!

if ! wait_http_ok "http://127.0.0.1:${API_PORT}/api/modules" 120 0.25; then
  echo "api readiness check failed"
  exit 1
fi

echo "run round4 e2e assertions"
(
  cd "$REPO_ROOT"
  API_URL="http://127.0.0.1:${API_PORT}" \
    EXPECT_RUNTIME=R \
    ASSERT_GO_KEGG=1 \
    EXPECT_GO_ID=GO:0006954 \
    EXPECT_KEGG_ID=hsa04060 \
    EXPECT_LOGS="Running limma + clusterProfiler via R runtime,Remote r-engine completed" \
    EXPECT_LOGS_ORDERED=1 \
    EXPECT_LOGS_ABSENT="fallback,R chain unavailable,Local Rscript runner failed" \
    api/scripts/e2e_round4.sh
)

echo "round4 CI gate passed"
