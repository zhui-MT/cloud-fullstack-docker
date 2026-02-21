#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:4000}"

run_resp=$(curl -sS -X POST "$API_URL/api/run/de-enrich" -H 'Content-Type: application/json' -d '{"engine":"limma"}')
job_id=$(echo "$run_resp" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')

if [[ -z "$job_id" ]]; then
  echo "Failed to submit job"
  echo "$run_resp"
  exit 1
fi

echo "job_id=$job_id"

declare -i max_try=30
for ((i=1; i<=max_try; i++)); do
  job_resp=$(curl -sS "$API_URL/api/job/$job_id")
  status=$(echo "$job_resp" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -n1)
  echo "try=$i status=$status"

  if [[ "$status" == "succeeded" || "$status" == "failed" ]]; then
    echo "$job_resp"
    exit 0
  fi
  sleep 1
done

echo "Timed out waiting for job"
exit 1
