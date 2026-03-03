#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

API_URL="${API_URL:-http://localhost:4000}"
SKIP_HEALTH="${SKIP_HEALTH:-0}"
SKIP_API="${SKIP_API:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
EXPECT_STORAGE_MODE="${EXPECT_STORAGE_MODE:-blob}"

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
    process.stdout.write(typeof cur === "string" ? cur : JSON.stringify(cur));
  '
}

echo "[smoke] compose config"
docker compose --env-file .env.example config >/dev/null

if [[ "$SKIP_BUILD" == "1" ]]; then
  echo "[smoke] SKIP_BUILD=1, skip compose build"
elif docker info >/dev/null 2>&1; then
  echo "[smoke] compose build r-engine"
  docker compose --env-file .env.example build r-engine >/dev/null
else
  echo "[smoke] docker daemon unavailable, skip build step"
fi

if [[ "$SKIP_API" == "1" ]]; then
  echo "[smoke] SKIP_API=1, skip runtime API checks"
  echo "PASS: compose smoke checks passed (config/build only)."
  exit 0
fi

if [[ "$SKIP_HEALTH" != "1" ]]; then
  echo "[smoke] health"
  curl -fsS "${API_URL}/api/health" >/tmp/compose_smoke_health.json
fi

echo "[smoke] analysis"
analysis_json="$(curl -fsS "${API_URL}/api/analysis?config_rev=smoke-001")"
csv_path="$(json_field "$analysis_json" "views.pca.downloads.csv")"
meta_path="$(json_field "$analysis_json" "views.pca.downloads.meta")"

if [[ "$csv_path" != /* ]]; then
  echo "Invalid csv download path: $csv_path"
  exit 1
fi

echo "[smoke] artifact csv"
curl -fsS -D /tmp/compose_smoke_csv_headers.txt "${API_URL}${csv_path}" >/tmp/compose_smoke_pca.csv
if ! grep -qi '^X-Artifact-Meta:' /tmp/compose_smoke_csv_headers.txt; then
  echo "Missing X-Artifact-Meta header on csv download"
  exit 1
fi

echo "[smoke] artifact meta"
curl -fsS "${API_URL}${meta_path}" >/tmp/compose_smoke_meta.json

echo "[smoke] session"
session_json="$(curl -fsS -X POST "${API_URL}/api/session" \
  -H 'content-type: application/json' \
  -d '{"name":"compose-smoke"}')"
session_id="$(json_field "$session_json" "sessionId")"

sample_file="${ROOT_DIR}/services/api/samples/fragpipe-protein.tsv"
if [[ ! -f "$sample_file" ]]; then
  echo "Missing sample file: $sample_file"
  exit 1
fi

echo "[smoke] upload"
upload_json="$(curl -fsS -X POST "${API_URL}/api/upload" \
  -F "sessionId=${session_id}" \
  -F "file=@${sample_file}")"
upload_id="$(json_field "$upload_json" "uploadId")"
mapped_count="$(json_field "$upload_json" "summary.sampleCount")"
if [[ "$mapped_count" != "2" ]]; then
  echo "Unexpected sample count from upload: $mapped_count"
  exit 1
fi
storage_mode="$(json_field "$upload_json" "storage.mode")"
if [[ "$storage_mode" != "$EXPECT_STORAGE_MODE" ]]; then
  echo "Unexpected upload storage mode: $storage_mode (expected $EXPECT_STORAGE_MODE)"
  exit 1
fi

echo "[smoke] upload detail"
detail_json="$(curl -fsS "${API_URL}/api/upload/${upload_id}")"
detail_mode="$(json_field "$detail_json" "storage.mode")"
if [[ "$detail_mode" != "$EXPECT_STORAGE_MODE" ]]; then
  echo "Unexpected detail storage mode: $detail_mode (expected $EXPECT_STORAGE_MODE)"
  exit 1
fi
printf '%s' "$detail_json" >/tmp/compose_smoke_upload_detail.json

echo "[smoke] upload mapped rows page"
mapped_json="$(curl -fsS "${API_URL}/api/upload/${upload_id}/mapped-rows?limit=1&offset=0")"
returned="$(json_field "$mapped_json" "returned")"
if [[ "$returned" != "1" ]]; then
  echo "Unexpected mapped rows page size: $returned"
  exit 1
fi
page_mode="$(json_field "$mapped_json" "storage.mode")"
if [[ "$page_mode" != "$EXPECT_STORAGE_MODE" ]]; then
  echo "Unexpected mapped rows storage mode: $page_mode (expected $EXPECT_STORAGE_MODE)"
  exit 1
fi

echo "[smoke] session upload list"
list_json="$(curl -fsS "${API_URL}/api/session/${session_id}/uploads?limit=1&offset=0")"
list_total="$(json_field "$list_json" "total")"
if [[ "$list_total" != "1" ]]; then
  echo "Unexpected session upload total: $list_total"
  exit 1
fi
list_returned="$(json_field "$list_json" "returned")"
if [[ "$list_returned" != "1" ]]; then
  echo "Unexpected session upload returned: $list_returned"
  exit 1
fi

echo "[smoke] delete upload"
delete_json="$(curl -fsS -X DELETE "${API_URL}/api/upload/${upload_id}")"
delete_ok="$(json_field "$delete_json" "ok")"
if [[ "$delete_ok" != "true" ]]; then
  echo "Delete upload failed"
  exit 1
fi

echo "[smoke] session upload list after delete"
list_after_json="$(curl -fsS "${API_URL}/api/session/${session_id}/uploads?limit=1&offset=0")"
list_after_total="$(json_field "$list_after_json" "total")"
if [[ "$list_after_total" != "0" ]]; then
  echo "Unexpected session upload total after delete: $list_after_total"
  exit 1
fi

echo "[smoke] upload again for bulk session delete"
upload2_json="$(curl -fsS -X POST "${API_URL}/api/upload" \
  -F "sessionId=${session_id}" \
  -F "file=@${sample_file}")"
upload2_id="$(json_field "$upload2_json" "uploadId")"
if [[ -z "$upload2_id" ]]; then
  echo "Second upload failed"
  exit 1
fi

echo "[smoke] delete session uploads"
session_delete_json="$(curl -fsS -X DELETE "${API_URL}/api/session/${session_id}/uploads")"
session_delete_ok="$(json_field "$session_delete_json" "ok")"
if [[ "$session_delete_ok" != "true" ]]; then
  echo "Delete session uploads failed"
  exit 1
fi
session_deleted_count="$(json_field "$session_delete_json" "deletedCount")"
if [[ "$session_deleted_count" != "1" ]]; then
  echo "Unexpected deletedCount from session delete: $session_deleted_count"
  exit 1
fi

echo "[smoke] session upload list after bulk delete"
list_after_bulk_json="$(curl -fsS "${API_URL}/api/session/${session_id}/uploads?limit=1&offset=0")"
list_after_bulk_total="$(json_field "$list_after_bulk_json" "total")"
if [[ "$list_after_bulk_total" != "0" ]]; then
  echo "Unexpected session upload total after bulk delete: $list_after_bulk_total"
  exit 1
fi

echo "PASS: compose smoke checks passed."
