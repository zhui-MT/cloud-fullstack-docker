#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MESSAGE="${1:-}"
TAG_PREFIX="${2:-snapshot}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "FAIL: current directory is not a git repository"
  exit 1
fi

if [ -z "$(git status --porcelain)" ]; then
  echo "No changes to snapshot."
  exit 0
fi

if [ -z "$MESSAGE" ]; then
  MESSAGE="chore: snapshot $(date +%Y-%m-%dT%H:%M:%S)"
fi

git add -A
git commit -m "$MESSAGE"

TAG_NAME="${TAG_PREFIX}-$(date +%Y%m%d-%H%M%S)"
git tag "$TAG_NAME"

echo "Snapshot created."
echo "Commit: $(git rev-parse --short HEAD)"
echo "Tag:    $TAG_NAME"
