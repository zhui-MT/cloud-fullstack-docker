#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:4000}"
EXPECT_RUNTIME="${EXPECT_RUNTIME:-}"

json_field() {
  local json="$1"
  local field="$2"
  JSON_INPUT="$json" FIELD_NAME="$field" node -e '
    const obj = JSON.parse(process.env.JSON_INPUT || "{}");
    const field = process.env.FIELD_NAME || "";
    const parts = field.split(".");
    let cur = obj;
    for (const part of parts) {
      if (!part) continue;
      cur = cur?.[part];
    }
    if (cur === undefined || cur === null) process.exit(1);
    if (typeof cur === "object") {
      process.stdout.write(JSON.stringify(cur));
    } else {
      process.stdout.write(String(cur));
    }
  '
}

run_resp=$(curl -sS -X POST "$API_URL/api/run/de-enrich" -H 'Content-Type: application/json' -d '{"engine":"limma"}')
job_id=$(json_field "$run_resp" "jobId" || true)

if [[ -z "$job_id" ]]; then
  echo "Failed to submit job"
  echo "$run_resp"
  exit 1
fi

echo "job_id=$job_id"

declare -i max_try=30
for ((i=1; i<=max_try; i++)); do
  job_resp=$(curl -sS "$API_URL/api/job/$job_id")
  status=$(json_field "$job_resp" "status" || true)
  echo "try=$i status=$status"

  if [[ "$status" == "succeeded" || "$status" == "failed" ]]; then
    runtime=$(json_field "$job_resp" "result.runtime.backend" || true)
    sig_count=$(json_field "$job_resp" "result.de.summary.significantGenes" || true)
    echo "runtime=${runtime:-unknown} significantGenes=${sig_count:-unknown}"

    if [[ -n "$EXPECT_RUNTIME" && "$runtime" != "$EXPECT_RUNTIME" ]]; then
      echo "Expected runtime '$EXPECT_RUNTIME' but got '${runtime:-empty}'"
      echo "$job_resp"
      exit 1
    fi

    echo "$job_resp"
    exit 0
  fi
  sleep 1
done

echo "Timed out waiting for job"
exit 1
