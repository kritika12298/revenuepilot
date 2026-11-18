#!/usr/bin/env bash
# PostgreSQL backup with retention. Installed by setup-vps.sh as
# /usr/local/bin/revenuepilot-backup and run nightly from cron.
#   RETAIN_DAYS=14 BACKUP_DIR=/var/backups/revenuepilot revenuepilot-backup
# Restore:  pg_restore --clean --if-exists -d "$DATABASE_URL" <file>.dump
# Copy backups off the server too (e.g. rclone to object storage): a backup on
# the same disk does not survive losing the VPS.
set -euo pipefail
APP_DIR="${APP_DIR:-/var/www/revenuepilot}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/revenuepilot}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

DATABASE_URL="$(grep -E '^DATABASE_URL=' "$APP_DIR/apps/api/.env" | cut -d= -f2-)"
DATABASE_URL="${DATABASE_URL%%\?*}"   # pg_dump does not accept Prisma's ?schema=
[[ -n $DATABASE_URL ]] || { echo "DATABASE_URL not found" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/revenuepilot-$(date -u +%Y%m%dT%H%M%SZ).dump"
umask 077
pg_dump --format=custom --no-owner --file="$file" "$DATABASE_URL"
pg_restore --list "$file" >/dev/null   # verify the archive is readable
find "$BACKUP_DIR" -name 'revenuepilot-*.dump' -mtime +"$RETAIN_DAYS" -delete
echo "$(date -u +%FT%TZ) backup ok: $file ($(du -h "$file" | cut -f1))"
