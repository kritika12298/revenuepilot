#!/usr/bin/env bash
# Build and (re)start RevenuePilot. Run as the app user from the repo root:
#   bash deploy/deploy.sh            # pull, install, migrate, build, reload
#   SEED=1 bash deploy/deploy.sh     # also load the demo data (wipes demo businesses only)
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f apps/api/.env ]] || { echo "apps/api/.env is missing (see deploy/setup-vps.sh)" >&2; exit 1; }

if [[ -d .git && "${PULL:-1}" == 1 ]]; then
  echo "==> git pull"
  git pull --ff-only
fi

echo "==> Install dependencies"
npm ci --no-audit --no-fund

echo "==> Database migrations"
npm run db:deploy

if [[ "${SEED:-0}" == 1 ]]; then
  echo "==> Demo data"
  npm run db:seed
fi

echo "==> Build dashboard"
npm run build

echo "==> Start / reload processes"
if pm2 describe revenuepilot-api >/dev/null 2>&1; then
  pm2 reload deploy/ecosystem.config.cjs --env production --update-env
else
  pm2 start deploy/ecosystem.config.cjs --env production
fi
pm2 save

echo "==> Health check"
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:4000/readyz >/dev/null; then echo "API ready"; exit 0; fi
  sleep 1
done
echo "API did not become ready; see: pm2 logs revenuepilot-api --lines 100" >&2
exit 1
