#!/usr/bin/env bash
# Restart without rebuilding (e.g. after editing apps/api/.env).
#   bash deploy/restart.sh          # API + worker
#   bash deploy/restart.sh api      # API only (zero-downtime cluster reload)
#   bash deploy/restart.sh worker   # worker only (waits for in-flight jobs)
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-all}" in
  api) pm2 reload revenuepilot-api --update-env ;;
  worker) pm2 restart revenuepilot-worker --update-env ;;
  all) pm2 reload deploy/ecosystem.config.cjs --env production --update-env ;;
  *) echo "usage: $0 [api|worker|all]" >&2; exit 1 ;;
esac
pm2 status
