#!/bin/bash
# Dumps the database, encrypts it with a public key (only the holder of the private key can read it, so a leaked
# bucket exposes nothing), uploads it to B2 and keeps only the newest N copies.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${B2_ENDPOINT:?B2_ENDPOINT is required, e.g. https://s3.us-west-004.backblazeb2.com}"
: "${B2_BUCKET:?B2_BUCKET is required}"
: "${B2_KEY_ID:?B2_KEY_ID is required}"
: "${B2_APP_KEY:?B2_APP_KEY is required}"
: "${BACKUP_AGE_PUBLIC_KEY:?BACKUP_AGE_PUBLIC_KEY is required (age1...)}"

KEEP="${BACKUP_RETENTION_COUNT:-30}"
PREFIX="${BACKUP_PREFIX:-db/}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
FILE="/tmp/onesystec-${STAMP}.dump.age"

export AWS_ACCESS_KEY_ID="$B2_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$B2_APP_KEY"
export AWS_DEFAULT_REGION="${B2_REGION:-us-west-004}"
export AWS_EC2_METADATA_DISABLED=true
s3() { aws --endpoint-url "$B2_ENDPOINT" s3 "$@"; }

echo "dumping..."
pg_dump --format=custom --no-owner --compress=9 "$DATABASE_URL" | age -r "$BACKUP_AGE_PUBLIC_KEY" -o "$FILE"

# A failed or empty dump must never replace a good backup or look like a success.
SIZE="$(wc -c < "$FILE")"
if [ "$SIZE" -lt 10000 ]; then
  echo "backup is suspiciously small (${SIZE} bytes), aborting" >&2
  exit 1
fi

echo "uploading ${SIZE} bytes..."
s3 cp "$FILE" "s3://${B2_BUCKET}/${PREFIX}onesystec-${STAMP}.dump.age" --only-show-errors
rm -f "$FILE"

echo "pruning, keeping the newest ${KEEP}..."
s3 ls "s3://${B2_BUCKET}/${PREFIX}" | awk '{print $4}' | grep '\.dump\.age$' | sort \
  | awk -v keep="$KEEP" '{ a[NR] = $0 } END { for (i = 1; i <= NR - keep; i++) print a[i] }' \
  | while read -r key; do
      echo "deleting old backup ${key}"
      s3 rm "s3://${B2_BUCKET}/${PREFIX}${key}" --only-show-errors
    done

echo "done"
