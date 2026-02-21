#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ROUND_NAME="${1:-unspecified}"
declare -a ERRORS=()
declare -a WARNINGS=()

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "FAIL: current directory is not a git repository"
  exit 1
fi

CHANGED_FILES="$(git status --porcelain | awk '{print $2}' | sed '/^$/d' || true)"

if [ -z "$CHANGED_FILES" ]; then
  WARNINGS+=("no working-tree changes detected")
fi

CODE_CHANGES="$(printf '%s\n' "$CHANGED_FILES" | grep -Ev '^(docs/|README\.md$|\.env(\.example)?$|\.gitignore$|scripts/)' || true)"
if [ -n "$CODE_CHANGES" ]; then
  if ! printf '%s\n' "$CHANGED_FILES" | grep -q '^docs/DEVLOG.md$'; then
    ERRORS+=("code changed but docs/DEVLOG.md was not updated")
  fi
fi

if [ ! -f ".env.example" ]; then
  ERRORS+=(".env.example missing")
else
  if ! docker compose --env-file .env.example config >/tmp/review_gate_compose.out 2>/tmp/review_gate_compose.err; then
    ERRORS+=("docker compose config failed; inspect /tmp/review_gate_compose.err")
  else
    api_context="$(awk '
      /^  api:/ { in_api=1; next }
      in_api && /context:/ { print $2; exit }
      in_api && /^[^ ]/ { in_api=0 }
    ' /tmp/review_gate_compose.out)"
    if [[ -z "$api_context" || "$api_context" != */backend ]]; then
      ERRORS+=("compose api service must build from ./backend (current: ${api_context:-unknown})")
    fi
  fi
fi

if [ -d "scripts" ]; then
  while IFS= read -r -d '' script_file; do
    if ! bash -n "$script_file"; then
      ERRORS+=("shell syntax check failed: $script_file")
    fi
  done < <(find scripts -maxdepth 1 -type f -name '*.sh' -print0)
fi

echo "Review Gate Report"
echo "Round: $ROUND_NAME"
echo "Repo:  $ROOT_DIR"

if [ "${#WARNINGS[@]}" -gt 0 ]; then
  echo "Warnings:"
  for w in "${WARNINGS[@]}"; do
    echo "- $w"
  done
fi

if [ "${#ERRORS[@]}" -gt 0 ]; then
  echo "Errors:"
  for e in "${ERRORS[@]}"; do
    echo "- $e"
  done
  exit 1
fi

echo "PASS: review gate checks passed."
