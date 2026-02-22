#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:4000}"
EXPECT_RUNTIME="${EXPECT_RUNTIME:-}"
ASSERT_GO_KEGG="${ASSERT_GO_KEGG:-0}"
EXPECT_GO_ID="${EXPECT_GO_ID:-}"
EXPECT_KEGG_ID="${EXPECT_KEGG_ID:-}"
EXPECT_LOGS="${EXPECT_LOGS:-}"
EXPECT_LOGS_ORDERED="${EXPECT_LOGS_ORDERED:-0}"
EXPECT_LOGS_ABSENT="${EXPECT_LOGS_ABSENT:-}"

json_field() {
  local json="$1"
  local field="$2"
  JSON_INPUT="$json" FIELD_NAME="$field" node -e '
    const obj = JSON.parse(process.env.JSON_INPUT || "{}");
    const parts = (process.env.FIELD_NAME || "").split(".");
    let cur = obj;
    for (const part of parts) {
      if (!part) continue;
      cur = cur?.[part];
    }
    if (cur === undefined || cur === null) process.exit(1);
    process.stdout.write(typeof cur === "object" ? JSON.stringify(cur) : String(cur));
  '
}

extract_highlights() {
  local json="$1"
  JSON_INPUT="$json" node -e '
    const obj = JSON.parse(process.env.JSON_INPUT || "{}");
    const logs = Array.isArray(obj.logs) ? obj.logs : [];
    const highlights = logs
      .filter((x) => typeof x?.message === "string")
      .filter((x) => x.message.includes("Running limma") || x.message.includes("fallback") || x.message.includes("Remote r-engine completed"))
      .map((x) => x.message)
      .slice(0, 6);
    const out = {
      status: obj.status ?? null,
      module: obj.module ?? null,
      engine: obj.result?.engine ?? obj.request?.engine ?? null,
      retryCount: obj.retryCount ?? 0,
      runtimeBackend: obj.result?.runtime?.backend ?? null,
      deSignificantGenes: obj.result?.de?.summary?.significantGenes ?? null,
      goTopId: obj.result?.enrichment?.go?.[0]?.id ?? null,
      keggTopId: obj.result?.enrichment?.kegg?.[0]?.id ?? null,
      errorCode: obj.error?.code ?? null,
      logHighlights: highlights
    };
    process.stdout.write(JSON.stringify(out));
  '
}

log_contains() {
  local json="$1"
  local expected="$2"
  JSON_INPUT="$json" EXPECTED_LOG="$expected" node -e '
    const obj = JSON.parse(process.env.JSON_INPUT || "{}");
    const expected = String(process.env.EXPECTED_LOG || "");
    const logs = Array.isArray(obj.logs) ? obj.logs : [];
    const hit = logs.some((x) => typeof x?.message === "string" && x.message.includes(expected));
    process.exit(hit ? 0 : 1);
  '
}

logs_contains_in_order() {
  local json="$1"
  local expected_csv="$2"
  JSON_INPUT="$json" EXPECTED_LOGS="$expected_csv" node -e '
    const obj = JSON.parse(process.env.JSON_INPUT || "{}");
    const expectedRaw = String(process.env.EXPECTED_LOGS || "");
    const expected = expectedRaw
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (expected.length === 0) process.exit(0);
    const logs = Array.isArray(obj.logs) ? obj.logs : [];
    const messages = logs
      .map((x) => (typeof x?.message === "string" ? x.message : ""))
      .filter(Boolean);
    let cursor = 0;
    for (const message of messages) {
      if (message.includes(expected[cursor])) {
        cursor += 1;
        if (cursor >= expected.length) break;
      }
    }
    process.exit(cursor >= expected.length ? 0 : 1);
  '
}

log_absent() {
  local json="$1"
  local forbidden="$2"
  JSON_INPUT="$json" FORBIDDEN_LOG="$forbidden" node -e '
    const obj = JSON.parse(process.env.JSON_INPUT || "{}");
    const forbidden = String(process.env.FORBIDDEN_LOG || "");
    const logs = Array.isArray(obj.logs) ? obj.logs : [];
    const hit = logs.some((x) => typeof x?.message === "string" && x.message.includes(forbidden));
    process.exit(hit ? 1 : 0);
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

for i in $(seq 1 30); do
  job_resp=$(curl -sS "$API_URL/api/job/$job_id")
  status=$(json_field "$job_resp" "status" || true)
  echo "try=$i status=$status"

  if [[ "$status" == "succeeded" || "$status" == "failed" || "$status" == "canceled" ]]; then
    runtime=$(json_field "$job_resp" "result.runtime.backend" || true)
    sig_count=$(json_field "$job_resp" "result.de.summary.significantGenes" || true)
    go_top=$(json_field "$job_resp" "result.enrichment.go.0.id" || true)
    kegg_top=$(json_field "$job_resp" "result.enrichment.kegg.0.id" || true)
    echo "runtime=${runtime:-unknown} significantGenes=${sig_count:-unknown}"
    echo "highlights=$(extract_highlights "$job_resp")"

    if [[ -n "$EXPECT_RUNTIME" && "$runtime" != "$EXPECT_RUNTIME" ]]; then
      echo "Expected runtime '$EXPECT_RUNTIME' but got '${runtime:-empty}'"
      echo "$job_resp"
      exit 1
    fi

    if [[ "$ASSERT_GO_KEGG" == "1" ]]; then
      if [[ -z "$go_top" || -z "$kegg_top" ]]; then
        echo "Expected GO/KEGG enrichment ids but got go='${go_top:-empty}', kegg='${kegg_top:-empty}'"
        echo "$job_resp"
        exit 1
      fi
    fi

    if [[ -n "$EXPECT_GO_ID" && "$go_top" != "$EXPECT_GO_ID" ]]; then
      echo "Expected GO id '$EXPECT_GO_ID' but got '${go_top:-empty}'"
      echo "$job_resp"
      exit 1
    fi

    if [[ -n "$EXPECT_KEGG_ID" && "$kegg_top" != "$EXPECT_KEGG_ID" ]]; then
      echo "Expected KEGG id '$EXPECT_KEGG_ID' but got '${kegg_top:-empty}'"
      echo "$job_resp"
      exit 1
    fi

    if [[ -n "$EXPECT_LOGS" ]]; then
      if [[ "$EXPECT_LOGS_ORDERED" == "1" ]]; then
        if ! logs_contains_in_order "$job_resp" "$EXPECT_LOGS"; then
          echo "Expected ordered log keywords not found in order: '$EXPECT_LOGS'"
          echo "$job_resp"
          exit 1
        fi
      else
        IFS=',' read -r -a expected_logs <<< "$EXPECT_LOGS"
        for expected_log in "${expected_logs[@]}"; do
          expected_log="$(printf "%s" "$expected_log" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
          if [[ -z "$expected_log" ]]; then
            continue
          fi
          if ! log_contains "$job_resp" "$expected_log"; then
            echo "Expected log keyword '$expected_log' not found"
            echo "$job_resp"
            exit 1
          fi
        done
      fi
    fi

    if [[ -n "$EXPECT_LOGS_ABSENT" ]]; then
      IFS=',' read -r -a absent_logs <<< "$EXPECT_LOGS_ABSENT"
      for absent_log in "${absent_logs[@]}"; do
        absent_log="$(printf "%s" "$absent_log" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        if [[ -z "$absent_log" ]]; then
          continue
        fi
        if ! log_absent "$job_resp" "$absent_log"; then
          echo "Forbidden log keyword found: '$absent_log'"
          echo "$job_resp"
          exit 1
        fi
      done
    fi

    echo "$job_resp"
    jobs_resp=$(curl -sS "$API_URL/api/jobs?limit=1")
    total_jobs=$(json_field "$jobs_resp" "total" || true)
    echo "jobs_total=${total_jobs:-unknown}"
    exit 0
  fi

  sleep 1
done

echo "Timed out waiting for job"
exit 1
