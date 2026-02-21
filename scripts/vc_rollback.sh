#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET="${1:-}"
ROLLBACK_BRANCH="${2:-rollback-$(date +%Y%m%d-%H%M%S)}"

if [ -z "$TARGET" ]; then
  echo "Usage: scripts/vc_rollback.sh <commit-or-tag> [rollback-branch-name]"
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "FAIL: current directory is not a git repository"
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "FAIL: working tree is not clean. Run snapshot first:"
  echo "  scripts/vc_snapshot.sh \"chore: pre-rollback snapshot\""
  exit 1
fi

if ! git rev-parse --verify "${TARGET}^{commit}" >/dev/null 2>&1; then
  echo "FAIL: target not found: $TARGET"
  exit 1
fi

BACKUP_BRANCH="backup-pre-rollback-$(date +%Y%m%d-%H%M%S)"
git branch "$BACKUP_BRANCH"
git switch -c "$ROLLBACK_BRANCH" "$TARGET"

echo "Rollback branch created."
echo "Backup branch:   $BACKUP_BRANCH"
echo "Rollback branch: $ROLLBACK_BRANCH"
echo "Target:          $TARGET"
