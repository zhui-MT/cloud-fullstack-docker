#!/usr/bin/env bash
set -u -o pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUTPUT_FILE="${1:-docs/PROGRESS_STATUS.md}"
RUN_TESTS="${RUN_TESTS:-1}"
RUN_GATE="${RUN_GATE:-1}"
RUN_SMOKE="${RUN_SMOKE:-1}"
SMOKE_SKIP_BUILD="${SMOKE_SKIP_BUILD:-1}"
SMOKE_SKIP_HEALTH="${SMOKE_SKIP_HEALTH:-0}"
TOP_N_PATHS="${TOP_N_PATHS:-10}"
STRICT_MODE="${STRICT_MODE:-0}"
SAVE_HISTORY="${SAVE_HISTORY:-1}"
HISTORY_DIR="${HISTORY_DIR:-docs/progress_history}"
HISTORY_RETENTION_DAYS="${HISTORY_RETENTION_DAYS:-14}"
TREND_OUTPUT_FILE="${TREND_OUTPUT_FILE:-docs/PROGRESS_TREND.md}"
TREND_WINDOW="${TREND_WINDOW:-20}"
BLOCKER_TOP_N="${BLOCKER_TOP_N:-5}"
METRICS_OUTPUT_FILE="${METRICS_OUTPUT_FILE:-docs/PROGRESS_METRICS.prom}"
if [[ "$OUTPUT_FILE" == *.* ]]; then
  default_json_output="${OUTPUT_FILE%.*}.json"
else
  default_json_output="${OUTPUT_FILE}.json"
fi
JSON_OUTPUT_FILE="${JSON_OUTPUT_FILE:-$default_json_output}"
PREV_JSON_FILE="${PREV_JSON_FILE:-$JSON_OUTPUT_FILE}"

declare -a TMP_FILES=()
cleanup() {
  local f
  for f in "${TMP_FILES[@]}"; do
    rm -f "$f"
  done
}
trap cleanup EXIT

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "FAIL: current directory is not a git repository"
  exit 1
fi

report_dir="$(dirname "$OUTPUT_FILE")"
mkdir -p "$report_dir"
json_dir="$(dirname "$JSON_OUTPUT_FILE")"
mkdir -p "$json_dir"
trend_dir="$(dirname "$TREND_OUTPUT_FILE")"
mkdir -p "$trend_dir"
metrics_dir="$(dirname "$METRICS_OUTPUT_FILE")"
mkdir -p "$metrics_dir"
if [[ "$SAVE_HISTORY" == "1" ]]; then
  mkdir -p "$HISTORY_DIR"
fi

timestamp_local="$(date '+%Y-%m-%d %H:%M:%S %z')"
timestamp_utc="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

branch="$(git branch --show-current 2>/dev/null || echo detached)"
head_sha="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
head_subject="$(git show -s --format='%s' HEAD 2>/dev/null || echo unknown)"
head_date="$(git show -s --format='%ci' HEAD 2>/dev/null || echo unknown)"
head_tags="$(git tag --points-at HEAD | paste -sd ', ' -)"
if [[ -z "$head_tags" ]]; then
  head_tags="none"
fi

status_lines="$(git status --porcelain=v1 || true)"
total_changes="$(printf '%s\n' "$status_lines" | sed '/^$/d' | wc -l | tr -d ' ')"
staged_changes="$(printf '%s\n' "$status_lines" | awk 'substr($0,1,2)!="??" && substr($0,1,1)!=" " {c++} END{print c+0}')"
unstaged_changes="$(printf '%s\n' "$status_lines" | awk 'substr($0,1,2)!="??" && substr($0,2,1)!=" " {c++} END{print c+0}')"
untracked_changes="$(printf '%s\n' "$status_lines" | awk 'substr($0,1,2)=="??" {c++} END{print c+0}')"

top_paths="$(git status --porcelain=v1 | awk '
  {
    line=$0;
    sub(/^.. /, "", line);
    sub(/ -> .*/, "", line);
    split(line, a, "/");
    if (a[1] != "") print a[1];
  }
' | sort | uniq -c | sort -nr | head -n "$TOP_N_PATHS" || true)"
if [[ -z "$top_paths" ]]; then
  top_paths="(clean)"
fi

changed_preview="$(git status --short | head -n 25 || true)"
if [[ -z "$changed_preview" ]]; then
  changed_preview="(clean)"
fi

round_lines="$(rg '^## ' docs/DEVLOG.md 2>/dev/null || true)"
latest_round="$(printf '%s\n' "$round_lines" | tail -n 1)"
recent_rounds="$(printf '%s\n' "$round_lines" | tail -n 5)"
if [[ -z "$latest_round" ]]; then
  latest_round="unknown"
fi
if [[ -z "$recent_rounds" ]]; then
  recent_rounds="unknown"
fi

prev_json_snapshot=""
if [[ -f "$PREV_JSON_FILE" ]]; then
  prev_json_snapshot="$(mktemp)"
  TMP_FILES+=("$prev_json_snapshot")
  cp "$PREV_JSON_FILE" "$prev_json_snapshot"
fi

docker_status="UNAVAILABLE"
running_services_count="0"
running_services="none"
if docker info >/dev/null 2>&1; then
  docker_status="AVAILABLE"
  running_raw="$(docker compose ps --status running --services 2>/dev/null || true)"
  running_services_count="$(printf '%s\n' "$running_raw" | sed '/^$/d' | wc -l | tr -d ' ')"
  running_services="$(printf '%s\n' "$running_raw" | sed '/^$/d' | paste -sd ',' - | sed 's/,/, /g')"
  if [[ -z "$running_services" ]]; then
    running_services="none"
  fi
fi

api_test_status="SKIPPED"
api_test_pass="-"
api_test_fail="-"
api_test_duration="-"
api_test_log=""

backend_test_status="SKIPPED"
backend_test_pass="-"
backend_test_fail="-"
backend_test_duration="-"
backend_test_log=""

if [[ "$RUN_TESTS" == "1" ]]; then
  api_test_log="$(mktemp)"
  TMP_FILES+=("$api_test_log")
  if (cd "$ROOT_DIR/api" && npm test >"$api_test_log" 2>&1); then
    api_test_status="PASS"
  else
    api_test_status="FAIL"
  fi
  api_test_pass="$(awk '/^# pass /{v=$3} END{if(v=="") print "-"; else print v}' "$api_test_log")"
  api_test_fail="$(awk '/^# fail /{v=$3} END{if(v=="") print "-"; else print v}' "$api_test_log")"
  api_test_duration="$(awk '/^# duration_ms /{v=$3} END{if(v=="") print "-"; else print v "ms"}' "$api_test_log")"

  backend_test_log="$(mktemp)"
  TMP_FILES+=("$backend_test_log")
  if (cd "$ROOT_DIR/backend" && npm test >"$backend_test_log" 2>&1); then
    backend_test_status="PASS"
  else
    backend_test_status="FAIL"
  fi
  backend_test_pass="$(awk '/^# pass /{v=$3} END{if(v=="") print "-"; else print v}' "$backend_test_log")"
  backend_test_fail="$(awk '/^# fail /{v=$3} END{if(v=="") print "-"; else print v}' "$backend_test_log")"
  backend_test_duration="$(awk '/^# duration_ms /{v=$3} END{if(v=="") print "-"; else print v "ms"}' "$backend_test_log")"
fi

review_gate_status="SKIPPED"
review_gate_tail="(not executed)"
if [[ "$RUN_GATE" == "1" ]]; then
  gate_log="$(mktemp)"
  TMP_FILES+=("$gate_log")
  gate_round="monitor-$(date '+%Y%m%d-%H%M%S')"
  if scripts/review_gate.sh "$gate_round" >"$gate_log" 2>&1; then
    review_gate_status="PASS"
  else
    review_gate_status="FAIL"
  fi
  review_gate_tail="$(tail -n 6 "$gate_log")"
fi

smoke_status="SKIPPED"
smoke_tail="(not executed)"
if [[ "$RUN_SMOKE" == "1" ]]; then
  smoke_log="$(mktemp)"
  TMP_FILES+=("$smoke_log")
  if SKIP_BUILD="$SMOKE_SKIP_BUILD" SKIP_HEALTH="$SMOKE_SKIP_HEALTH" scripts/compose_smoke.sh >"$smoke_log" 2>&1; then
    smoke_status="PASS"
  else
    smoke_status="FAIL"
  fi
  smoke_tail="$(tail -n 10 "$smoke_log")"
fi

overall_status="IN_PROGRESS"
if [[ "$api_test_status" == "PASS" && "$backend_test_status" == "PASS" && "$review_gate_status" == "PASS" ]]; then
  overall_status="CODE_HEALTHY"
fi
if [[ "$smoke_status" == "FAIL" ]]; then
  overall_status="BLOCKED_ON_RUNTIME"
fi
if [[ "$api_test_status" == "FAIL" || "$backend_test_status" == "FAIL" || "$review_gate_status" == "FAIL" ]]; then
  overall_status="BLOCKED_ON_QUALITY"
fi

declare -a blockers=()
if [[ "$api_test_status" == "FAIL" ]]; then
  blockers+=("api test failed")
fi
if [[ "$backend_test_status" == "FAIL" ]]; then
  blockers+=("backend test failed")
fi
if [[ "$review_gate_status" == "FAIL" ]]; then
  blockers+=("review gate failed")
fi
if [[ "$smoke_status" == "FAIL" ]]; then
  blockers+=("compose smoke failed (check runtime dependencies: api/db/redis/r-engine)")
fi
if [[ "$RUN_SMOKE" == "1" && "$docker_status" == "AVAILABLE" && "$running_services_count" == "0" ]]; then
  blockers+=("docker is available but no compose services are running")
fi

{
  echo "# Development Progress Snapshot"
  echo
  echo "- Generated at (local): ${timestamp_local}"
  echo "- Generated at (UTC): ${timestamp_utc}"
  echo "- Overall status: **${overall_status}**"
  echo "- Strict mode: ${STRICT_MODE}"
  echo "- Save history: ${SAVE_HISTORY}"
  echo "- History retention days: ${HISTORY_RETENTION_DAYS}"
  echo "- Trend output: ${TREND_OUTPUT_FILE}"
  echo "- Metrics output: ${METRICS_OUTPUT_FILE}"
  echo
  echo "## Repo Baseline"
  echo "- Branch: \`${branch}\`"
  echo "- HEAD: \`${head_sha}\`"
  echo "- HEAD subject: ${head_subject}"
  echo "- HEAD date: ${head_date}"
  echo "- HEAD tags: ${head_tags}"
  echo "- Latest DEVLOG section: ${latest_round}"
  echo
  echo "## Working Tree"
  echo "- Total changed files: ${total_changes}"
  echo "- Staged changes: ${staged_changes}"
  echo "- Unstaged changes: ${unstaged_changes}"
  echo "- Untracked files: ${untracked_changes}"
  echo
  echo "### Top Changed Paths"
  echo '```text'
  printf '%s\n' "$top_paths"
  echo '```'
  echo
  echo "### Changed Files Preview (Top 25)"
  echo '```text'
  printf '%s\n' "$changed_preview"
  echo '```'
  echo
  echo "## Validation Matrix"
  echo "- api tests: ${api_test_status} (pass=${api_test_pass}, fail=${api_test_fail}, duration=${api_test_duration})"
  echo "- backend tests: ${backend_test_status} (pass=${backend_test_pass}, fail=${backend_test_fail}, duration=${backend_test_duration})"
  echo "- review gate: ${review_gate_status}"
  echo "- compose smoke: ${smoke_status}"
  echo
  echo "### Review Gate Tail"
  echo '```text'
  printf '%s\n' "$review_gate_tail"
  echo '```'
  echo
  echo "### Compose Smoke Tail"
  echo '```text'
  printf '%s\n' "$smoke_tail"
  echo '```'
  echo
  echo "## Runtime Status"
  echo "- Docker daemon: ${docker_status}"
  echo "- Running compose services: ${running_services_count}"
  echo "- Running service list: ${running_services}"
  echo
  echo "## Recent DEVLOG Sections"
  echo '```text'
  printf '%s\n' "$recent_rounds"
  echo '```'
  echo
  echo "## Blockers"
  if [[ "${#blockers[@]}" -eq 0 ]]; then
    echo "- none"
  else
    for item in "${blockers[@]}"; do
      echo "- ${item}"
    done
  fi
} >"$OUTPUT_FILE"

if [[ "${#blockers[@]}" -eq 0 ]]; then
  blockers_lines=""
else
  blockers_lines="$(printf '%s\n' "${blockers[@]}")"
fi

TIMESTAMP_LOCAL="$timestamp_local" \
TIMESTAMP_UTC="$timestamp_utc" \
OVERALL_STATUS="$overall_status" \
BRANCH="$branch" \
HEAD_SHA="$head_sha" \
HEAD_SUBJECT="$head_subject" \
HEAD_DATE="$head_date" \
HEAD_TAGS="$head_tags" \
LATEST_ROUND="$latest_round" \
TOTAL_CHANGES="$total_changes" \
STAGED_CHANGES="$staged_changes" \
UNSTAGED_CHANGES="$unstaged_changes" \
UNTRACKED_CHANGES="$untracked_changes" \
TOP_PATHS="$top_paths" \
CHANGED_PREVIEW="$changed_preview" \
API_TEST_STATUS="$api_test_status" \
API_TEST_PASS="$api_test_pass" \
API_TEST_FAIL="$api_test_fail" \
API_TEST_DURATION="$api_test_duration" \
BACKEND_TEST_STATUS="$backend_test_status" \
BACKEND_TEST_PASS="$backend_test_pass" \
BACKEND_TEST_FAIL="$backend_test_fail" \
BACKEND_TEST_DURATION="$backend_test_duration" \
REVIEW_GATE_STATUS="$review_gate_status" \
REVIEW_GATE_TAIL="$review_gate_tail" \
SMOKE_STATUS="$smoke_status" \
SMOKE_TAIL="$smoke_tail" \
DOCKER_STATUS="$docker_status" \
RUNNING_SERVICES_COUNT="$running_services_count" \
RUNNING_SERVICES="$running_services" \
RECENT_ROUNDS="$recent_rounds" \
BLOCKERS_LINES="$blockers_lines" \
PREV_JSON_SNAPSHOT="$prev_json_snapshot" \
STRICT_MODE_VALUE="$STRICT_MODE" \
SAVE_HISTORY_VALUE="$SAVE_HISTORY" \
HISTORY_DIR_VALUE="$HISTORY_DIR" \
HISTORY_RETENTION_DAYS_VALUE="$HISTORY_RETENTION_DAYS" \
TREND_OUTPUT_FILE_VALUE="$TREND_OUTPUT_FILE" \
TREND_WINDOW_VALUE="$TREND_WINDOW" \
BLOCKER_TOP_N_VALUE="$BLOCKER_TOP_N" \
METRICS_OUTPUT_FILE_VALUE="$METRICS_OUTPUT_FILE" \
node - <<'NODE' >"$JSON_OUTPUT_FILE"
const fs = require('fs');

function splitLines(input) {
  return String(input || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullableNumberFromMs(value) {
  if (!value || value === '-') return null;
  const n = Number(String(value).replace(/ms$/, ''));
  return Number.isFinite(n) ? n : null;
}

const blockers = splitLines(process.env.BLOCKERS_LINES);
const topPaths = splitLines(process.env.TOP_PATHS);
const changedPreview = splitLines(process.env.CHANGED_PREVIEW);
const recentRounds = splitLines(process.env.RECENT_ROUNDS);
const reviewGateTail = splitLines(process.env.REVIEW_GATE_TAIL);
const smokeTail = splitLines(process.env.SMOKE_TAIL);

const now = {
  generated_at_local: process.env.TIMESTAMP_LOCAL,
  generated_at_utc: process.env.TIMESTAMP_UTC,
  overall_status: process.env.OVERALL_STATUS,
  monitor_config: {
    strict_mode: process.env.STRICT_MODE_VALUE === '1',
    save_history: process.env.SAVE_HISTORY_VALUE === '1',
    history_dir: process.env.HISTORY_DIR_VALUE,
    history_retention_days: toInt(process.env.HISTORY_RETENTION_DAYS_VALUE),
    trend_output_file: process.env.TREND_OUTPUT_FILE_VALUE,
    trend_window: toInt(process.env.TREND_WINDOW_VALUE),
    blocker_top_n: toInt(process.env.BLOCKER_TOP_N_VALUE),
    metrics_output_file: process.env.METRICS_OUTPUT_FILE_VALUE,
  },
  repo: {
    branch: process.env.BRANCH,
    head_sha: process.env.HEAD_SHA,
    head_subject: process.env.HEAD_SUBJECT,
    head_date: process.env.HEAD_DATE,
    head_tags: process.env.HEAD_TAGS,
    latest_devlog_section: process.env.LATEST_ROUND,
  },
  working_tree: {
    total_changed_files: toInt(process.env.TOTAL_CHANGES),
    staged_changes: toInt(process.env.STAGED_CHANGES),
    unstaged_changes: toInt(process.env.UNSTAGED_CHANGES),
    untracked_files: toInt(process.env.UNTRACKED_CHANGES),
    top_changed_paths: topPaths,
    changed_files_preview: changedPreview,
  },
  validation: {
    api_tests: {
      status: process.env.API_TEST_STATUS,
      pass: toInt(process.env.API_TEST_PASS),
      fail: toInt(process.env.API_TEST_FAIL),
      duration_ms: toNullableNumberFromMs(process.env.API_TEST_DURATION),
    },
    backend_tests: {
      status: process.env.BACKEND_TEST_STATUS,
      pass: toInt(process.env.BACKEND_TEST_PASS),
      fail: toInt(process.env.BACKEND_TEST_FAIL),
      duration_ms: toNullableNumberFromMs(process.env.BACKEND_TEST_DURATION),
    },
    review_gate: {
      status: process.env.REVIEW_GATE_STATUS,
      tail: reviewGateTail,
    },
    compose_smoke: {
      status: process.env.SMOKE_STATUS,
      tail: smokeTail,
    },
  },
  runtime: {
    docker_daemon: process.env.DOCKER_STATUS,
    running_services_count: toInt(process.env.RUNNING_SERVICES_COUNT),
    running_services: splitLines(String(process.env.RUNNING_SERVICES || '').replace(/,\s*/g, '\n')),
  },
  devlog_recent_sections: recentRounds,
  blockers,
};

let previous = null;
let delta = null;
const prevFile = process.env.PREV_JSON_SNAPSHOT;
if (prevFile && fs.existsSync(prevFile)) {
  try {
    previous = JSON.parse(fs.readFileSync(prevFile, 'utf8'));
  } catch {
    previous = null;
  }
}

if (previous && previous.working_tree) {
  const prevBlockers = Array.isArray(previous.blockers) ? previous.blockers : [];
  const prevSet = new Set(prevBlockers);
  const nowSet = new Set(blockers);
  delta = {
    since_previous_snapshot: {
      total_changed_files: now.working_tree.total_changed_files - (toInt(previous.working_tree.total_changed_files) ?? 0),
      staged_changes: now.working_tree.staged_changes - (toInt(previous.working_tree.staged_changes) ?? 0),
      unstaged_changes: now.working_tree.unstaged_changes - (toInt(previous.working_tree.unstaged_changes) ?? 0),
      untracked_files: now.working_tree.untracked_files - (toInt(previous.working_tree.untracked_files) ?? 0),
      blockers_added: blockers.filter((item) => !prevSet.has(item)),
      blockers_resolved: prevBlockers.filter((item) => !nowSet.has(item)),
      previous_overall_status: previous.overall_status ?? 'unknown',
      current_overall_status: now.overall_status,
    },
  };
}

const payload = { ...now };
if (delta) payload.delta = delta;

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
NODE

history_json_path="(not saved)"
history_md_path="(not saved)"
history_pruned_count=0
if [[ "$SAVE_HISTORY" == "1" ]]; then
  history_stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  history_json_path="${HISTORY_DIR}/${history_stamp}.json"
  history_md_path="${HISTORY_DIR}/${history_stamp}.md"
  cp "$JSON_OUTPUT_FILE" "$history_json_path"
  cp "$OUTPUT_FILE" "$history_md_path"
  cp "$JSON_OUTPUT_FILE" "${HISTORY_DIR}/latest.json"
  cp "$OUTPUT_FILE" "${HISTORY_DIR}/latest.md"

  retention_days="$HISTORY_RETENTION_DAYS"
  if ! [[ "$retention_days" =~ ^[0-9]+$ ]]; then
    retention_days=14
  fi
  if [[ "$retention_days" -gt 0 ]]; then
    before_count="$(find "$HISTORY_DIR" -maxdepth 1 -type f \( -name '*.json' -o -name '*.md' \) ! -name 'latest.json' ! -name 'latest.md' | wc -l | tr -d ' ')"
    find "$HISTORY_DIR" -maxdepth 1 -type f \( -name '*.json' -o -name '*.md' \) ! -name 'latest.json' ! -name 'latest.md' -mtime "+$((retention_days-1))" -delete
    after_count="$(find "$HISTORY_DIR" -maxdepth 1 -type f \( -name '*.json' -o -name '*.md' \) ! -name 'latest.json' ! -name 'latest.md' | wc -l | tr -d ' ')"
    if [[ "$before_count" =~ ^[0-9]+$ && "$after_count" =~ ^[0-9]+$ && "$before_count" -ge "$after_count" ]]; then
      history_pruned_count=$((before_count-after_count))
    fi
  fi
fi

HISTORY_DIR_PATH="$HISTORY_DIR" \
TREND_OUTPUT_PATH="$TREND_OUTPUT_FILE" \
TREND_WINDOW_SIZE="$TREND_WINDOW" \
BLOCKER_TOP_N_SIZE="$BLOCKER_TOP_N" \
node - <<'NODE'
const fs = require('fs');
const path = require('path');

const historyDir = process.env.HISTORY_DIR_PATH || 'docs/progress_history';
const trendOutput = process.env.TREND_OUTPUT_PATH || 'docs/PROGRESS_TREND.md';
const windowSize = Number(process.env.TREND_WINDOW_SIZE || 20);
const blockerTopN = Number(process.env.BLOCKER_TOP_N_SIZE || 5);

let files = [];
try {
  files = fs
    .readdirSync(historyDir)
    .filter((name) => name.endsWith('.json') && name !== 'latest.json')
    .sort();
} catch {
  files = [];
}

const selected = files.slice(-Math.max(windowSize, 1));
const snapshots = [];
for (const file of selected) {
  const fullPath = path.join(historyDir, file);
  try {
    const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    snapshots.push({ file, data: parsed });
  } catch {
    // Skip malformed snapshots.
  }
}

const statusCounts = {};
const blockerCounts = new Map();
let changedTotal = 0;
let changedSamples = 0;
let blockersActiveCount = 0;
let apiDurationTotal = 0;
let apiDurationSamples = 0;
let backendDurationTotal = 0;
let backendDurationSamples = 0;

for (const { data } of snapshots) {
  const status = data.overall_status || 'unknown';
  statusCounts[status] = (statusCounts[status] || 0) + 1;

  const changed = Number(data?.working_tree?.total_changed_files);
  if (Number.isFinite(changed)) {
    changedTotal += changed;
    changedSamples += 1;
  }

  const blockers = Array.isArray(data.blockers) ? data.blockers : [];
  if (blockers.length > 0) blockersActiveCount += 1;
  for (const blocker of blockers) {
    const key = String(blocker || '').trim();
    if (!key) continue;
    blockerCounts.set(key, (blockerCounts.get(key) || 0) + 1);
  }

  const apiDuration = Number(data?.validation?.api_tests?.duration_ms);
  if (Number.isFinite(apiDuration)) {
    apiDurationTotal += apiDuration;
    apiDurationSamples += 1;
  }

  const backendDuration = Number(data?.validation?.backend_tests?.duration_ms);
  if (Number.isFinite(backendDuration)) {
    backendDurationTotal += backendDuration;
    backendDurationSamples += 1;
  }
}

const avgChanged = changedSamples > 0 ? (changedTotal / changedSamples).toFixed(2) : '-';
const avgApiDuration = apiDurationSamples > 0 ? (apiDurationTotal / apiDurationSamples).toFixed(2) : '-';
const avgBackendDuration = backendDurationSamples > 0 ? (backendDurationTotal / backendDurationSamples).toFixed(2) : '-';
const sortedBlockers = Array.from(blockerCounts.entries()).sort((a, b) => b[1] - a[1]);

const lines = [];
lines.push('# Development Progress Trend');
lines.push('');
lines.push(`- Source history dir: \`${historyDir}\``);
lines.push(`- Trend window: last ${Math.max(windowSize, 1)} snapshot(s)`);
lines.push(`- Snapshots considered: ${snapshots.length}`);
lines.push('');

if (snapshots.length === 0) {
  lines.push('No historical snapshots found.');
  lines.push('');
} else {
  lines.push('## Summary');
  lines.push(`- Status distribution: ${Object.entries(statusCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  lines.push(`- Average changed files: ${avgChanged}`);
  lines.push(`- Snapshots with blockers: ${blockersActiveCount}/${snapshots.length}`);
  lines.push(`- Distinct blocker signatures: ${sortedBlockers.length}`);
  lines.push(`- Average api test duration (ms): ${avgApiDuration}`);
  lines.push(`- Average backend test duration (ms): ${avgBackendDuration}`);
  lines.push('');
  lines.push('## Blocker Hotspots');
  if (sortedBlockers.length === 0) {
    lines.push('- none');
  } else {
    lines.push('| Blocker | Frequency |');
    lines.push('| --- | ---: |');
    for (const [name, count] of sortedBlockers.slice(0, Math.max(blockerTopN, 1))) {
      lines.push(`| ${name.replace(/\|/g, '\\|')} | ${count} |`);
    }
  }
  lines.push('');
  lines.push('## Recent Snapshots');
  lines.push('| UTC | Status | Changed Files | Blockers | API Tests | Backend Tests |');
  lines.push('| --- | --- | ---: | ---: | --- | --- |');

  for (const { file, data } of snapshots) {
    const utc = data.generated_at_utc || file.replace('.json', '');
    const status = data.overall_status || 'unknown';
    const changed = data?.working_tree?.total_changed_files ?? '-';
    const blockers = Array.isArray(data.blockers) ? data.blockers.length : 0;
    const apiStatus = data?.validation?.api_tests?.status || '-';
    const backendStatus = data?.validation?.backend_tests?.status || '-';
    lines.push(`| ${utc} | ${status} | ${changed} | ${blockers} | ${apiStatus} | ${backendStatus} |`);
  }
  lines.push('');
}

fs.writeFileSync(trendOutput, `${lines.join('\n')}\n`);
NODE

status_to_num() {
  case "$1" in
    PASS|CODE_HEALTHY|AVAILABLE) echo "1" ;;
    FAIL|BLOCKED_ON_QUALITY|BLOCKED_ON_RUNTIME|UNAVAILABLE) echo "0" ;;
    SKIPPED|IN_PROGRESS) echo "-1" ;;
    *) echo "-1" ;;
  esac
}

duration_to_num() {
  local raw="$1"
  local n="${raw%ms}"
  if [[ "$n" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    echo "$n"
  else
    echo "0"
  fi
}

history_snapshot_count=0
if [[ "$SAVE_HISTORY" == "1" ]]; then
  history_snapshot_count="$(find "$HISTORY_DIR" -maxdepth 1 -type f -name '*.json' ! -name 'latest.json' | wc -l | tr -d ' ')"
fi

api_status_num="$(status_to_num "$api_test_status")"
backend_status_num="$(status_to_num "$backend_test_status")"
gate_status_num="$(status_to_num "$review_gate_status")"
smoke_status_num="$(status_to_num "$smoke_status")"
docker_status_num="$(status_to_num "$docker_status")"
overall_status_num="$(status_to_num "$overall_status")"
api_duration_num="$(duration_to_num "$api_test_duration")"
backend_duration_num="$(duration_to_num "$backend_test_duration")"
blockers_total="${#blockers[@]}"
blockers_active=0
if [[ "$blockers_total" -gt 0 ]]; then
  blockers_active=1
fi

cat >"$METRICS_OUTPUT_FILE" <<EOF
# HELP progress_overall_status_status Labeled overall progress status.
# TYPE progress_overall_status_status gauge
progress_overall_status_status{status="$overall_status"} 1
# HELP progress_overall_status_code Numeric overall status: 1 healthy, 0 blocked, -1 in-progress/unknown.
# TYPE progress_overall_status_code gauge
progress_overall_status_code $overall_status_num
# HELP progress_total_changed_files Total changed files in working tree.
# TYPE progress_total_changed_files gauge
progress_total_changed_files $total_changes
# HELP progress_staged_changes Staged changes count.
# TYPE progress_staged_changes gauge
progress_staged_changes $staged_changes
# HELP progress_unstaged_changes Unstaged changes count.
# TYPE progress_unstaged_changes gauge
progress_unstaged_changes $unstaged_changes
# HELP progress_untracked_files Untracked files count.
# TYPE progress_untracked_files gauge
progress_untracked_files $untracked_changes
# HELP progress_blockers_total Blockers count in current snapshot.
# TYPE progress_blockers_total gauge
progress_blockers_total $blockers_total
# HELP progress_blockers_active Whether blockers exist (1=true, 0=false).
# TYPE progress_blockers_active gauge
progress_blockers_active $blockers_active
# HELP progress_api_tests_status Numeric api test status.
# TYPE progress_api_tests_status gauge
progress_api_tests_status $api_status_num
# HELP progress_backend_tests_status Numeric backend test status.
# TYPE progress_backend_tests_status gauge
progress_backend_tests_status $backend_status_num
# HELP progress_review_gate_status Numeric review gate status.
# TYPE progress_review_gate_status gauge
progress_review_gate_status $gate_status_num
# HELP progress_compose_smoke_status Numeric compose smoke status.
# TYPE progress_compose_smoke_status gauge
progress_compose_smoke_status $smoke_status_num
# HELP progress_docker_daemon_status Numeric docker daemon availability.
# TYPE progress_docker_daemon_status gauge
progress_docker_daemon_status $docker_status_num
# HELP progress_api_test_duration_ms API test duration in ms.
# TYPE progress_api_test_duration_ms gauge
progress_api_test_duration_ms $api_duration_num
# HELP progress_backend_test_duration_ms Backend test duration in ms.
# TYPE progress_backend_test_duration_ms gauge
progress_backend_test_duration_ms $backend_duration_num
# HELP progress_running_services_count Number of running compose services.
# TYPE progress_running_services_count gauge
progress_running_services_count $running_services_count
# HELP progress_history_snapshots_total Number of history json snapshots retained.
# TYPE progress_history_snapshots_total gauge
progress_history_snapshots_total $history_snapshot_count
# HELP progress_history_pruned_count Number of history files pruned in this run.
# TYPE progress_history_pruned_count gauge
progress_history_pruned_count $history_pruned_count
EOF

{
  echo
  echo "## Monitor Outputs"
  echo "- Status markdown: ${OUTPUT_FILE}"
  echo "- Status json: ${JSON_OUTPUT_FILE}"
  echo "- Trend markdown: ${TREND_OUTPUT_FILE}"
  echo "- Metrics output: ${METRICS_OUTPUT_FILE}"
  echo "- History snapshot markdown: ${history_md_path}"
  echo "- History snapshot json: ${history_json_path}"
  echo "- History files pruned this run: ${history_pruned_count}"
} >>"$OUTPUT_FILE"

strict_failed=0
if [[ "$STRICT_MODE" == "1" ]]; then
  if [[ "${#blockers[@]}" -gt 0 ]]; then
    strict_failed=1
  elif [[ "$overall_status" == BLOCKED_* ]]; then
    strict_failed=1
  fi
fi

echo "Progress snapshot generated: $OUTPUT_FILE"
echo "Progress JSON generated: $JSON_OUTPUT_FILE"
echo "Progress trend generated: $TREND_OUTPUT_FILE"
echo "Progress metrics generated: $METRICS_OUTPUT_FILE"
if [[ "$SAVE_HISTORY" == "1" ]]; then
  echo "Progress history snapshot saved: $history_json_path"
fi
echo "Overall status: $overall_status"
if [[ "$strict_failed" == "1" ]]; then
  echo "FAIL: strict mode enabled and blockers detected."
  exit 2
fi
