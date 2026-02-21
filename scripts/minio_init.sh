#!/bin/sh
set -eu

BACKEND="${UPLOAD_BLOB_BACKEND:-fs}"
BACKEND_LOWER=$(printf '%s' "$BACKEND" | tr '[:upper:]' '[:lower:]')

if [ "$BACKEND_LOWER" = "fs" ]; then
  echo "[minio-init] UPLOAD_BLOB_BACKEND=fs, skip bucket initialization"
  exit 0
fi

if [ "$BACKEND_LOWER" != "s3" ] && [ "$BACKEND_LOWER" != "minio" ]; then
  echo "[minio-init] unsupported UPLOAD_BLOB_BACKEND=$BACKEND"
  exit 1
fi

: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
: "${UPLOAD_BLOB_BUCKET:?UPLOAD_BLOB_BUCKET is required}"

POLICY="${UPLOAD_BLOB_POLICY:-private}"
POLICY_LOWER=$(printf '%s' "$POLICY" | tr '[:upper:]' '[:lower:]')

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb -p "local/$UPLOAD_BLOB_BUCKET" || true

case "$POLICY_LOWER" in
  private)
    mc anonymous set none "local/$UPLOAD_BLOB_BUCKET"
    ;;
  public-read)
    mc anonymous set download "local/$UPLOAD_BLOB_BUCKET"
    ;;
  *)
    echo "[minio-init] unsupported UPLOAD_BLOB_POLICY=$POLICY"
    exit 1
    ;;
esac

echo "[minio-init] bucket ready: $UPLOAD_BLOB_BUCKET (policy=$POLICY_LOWER)"
