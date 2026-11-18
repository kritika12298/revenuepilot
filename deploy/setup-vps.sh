#!/usr/bin/env bash
# One-time provisioning of a GoDaddy VPS (Ubuntu 22.04/24.04) for RevenuePilot.
#
#   sudo DOMAIN=app.example.com EMAIL=you@example.com bash deploy/setup-vps.sh
#
# Installs Node 22, PostgreSQL, Redis, Nginx, PM2 and Certbot; binds Postgres
# and Redis to localhost with passwords; enables a firewall that allows only
# SSH, HTTP and HTTPS; creates the app user, database and a nightly backup.
# Safe to re-run. Secrets are generated on the server and never printed to logs
# except the final summary, which only shows where they were written.
set -euo pipefail

DOMAIN="${DOMAIN:?Set DOMAIN, e.g. DOMAIN=app.example.com}"
EMAIL="${EMAIL:?Set EMAIL for certificate expiry notices}"
APP_USER="${APP_USER:-revenuepilot}"
APP_DIR="${APP_DIR:-/var/www/revenuepilot}"
DB_NAME="${DB_NAME:-revenuepilot}"
DB_USER="${DB_USER:-revenuepilot}"

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }
rand() { node -e "console.log(require('crypto').randomBytes($1).toString('base64url'))" 2>/dev/null || openssl rand -base64 "$1" | tr -d '/+=\n'; }

echo "==> Packages"
apt-get update -y
apt-get install -y ca-certificates curl gnupg ufw nginx postgresql redis-server certbot python3-certbot-nginx
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install -g pm2

echo "==> Firewall: only 22, 80, 443"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "==> App user and directory"
id "$APP_USER" >/dev/null 2>&1 || adduser --system --group --home "/home/$APP_USER" --shell /bin/bash "$APP_USER"
mkdir -p "$APP_DIR" /var/backups/revenuepilot
chown -R "$APP_USER:$APP_USER" "$APP_DIR" /var/backups/revenuepilot

SECRETS=/etc/revenuepilot/secrets.env
mkdir -p /etc/revenuepilot && chmod 700 /etc/revenuepilot
if [[ ! -f $SECRETS ]]; then
  umask 077
  cat > "$SECRETS" <<EOS
DB_PASSWORD=$(rand 24)
REDIS_PASSWORD=$(rand 24)
JWT_SECRET=$(rand 48)
INTEGRATIONS_ENCRYPTION_KEY=$(openssl rand -base64 32)
EOS
fi
# shellcheck disable=SC1090
source "$SECRETS"

echo "==> PostgreSQL (localhost only)"
PG_CONF=$(sudo -u postgres psql -tAc 'SHOW config_file')
sed -i "s/^#\?listen_addresses.*/listen_addresses = 'localhost'/" "$PG_CONF"
systemctl restart postgresql
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD';
  ELSE
    ALTER ROLE $DB_USER PASSWORD '$DB_PASSWORD';
  END IF;
END \$\$;
SQL
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"

echo "==> Redis (localhost only, password)"
REDIS_CONF=/etc/redis/redis.conf
sed -i 's/^#\?\s*bind .*/bind 127.0.0.1 -::1/' "$REDIS_CONF"
sed -i 's/^#\?\s*protected-mode .*/protected-mode yes/' "$REDIS_CONF"
grep -q '^requirepass' "$REDIS_CONF" && sed -i "s/^requirepass .*/requirepass $REDIS_PASSWORD/" "$REDIS_CONF" || echo "requirepass $REDIS_PASSWORD" >> "$REDIS_CONF"
# BullMQ needs keys to survive restarts and must not be evicted.
grep -q '^maxmemory-policy' "$REDIS_CONF" && sed -i 's/^maxmemory-policy .*/maxmemory-policy noeviction/' "$REDIS_CONF" || echo 'maxmemory-policy noeviction' >> "$REDIS_CONF"
systemctl restart redis-server
systemctl enable postgresql redis-server nginx

echo "==> API environment (written once; edit $APP_DIR/apps/api/.env afterwards)"
ENV_FILE="$APP_DIR/apps/api/.env"
if [[ ! -f $ENV_FILE ]]; then
  mkdir -p "$(dirname "$ENV_FILE")"
  umask 077
  cat > "$ENV_FILE" <<EOS
NODE_ENV=production
PORT=4000
HOST=127.0.0.1
LOG_LEVEL=info
TRUST_PROXY=1
DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME?schema=public
REDIS_URL=redis://:$REDIS_PASSWORD@127.0.0.1:6379
JWT_SECRET=$JWT_SECRET
INTEGRATIONS_ENCRYPTION_KEY=$INTEGRATIONS_ENCRYPTION_KEY
CORS_ORIGINS=https://$DOMAIN
PUBLIC_BASE_URL=https://$DOMAIN
PUBLIC_WEB_URL=https://$DOMAIN
BCRYPT_ROUNDS=12
# AI: set ANTHROPIC_API_KEY for live Claude; without it agents run in mock mode.
AI_MODE=auto
# ANTHROPIC_API_KEY=
# Email: mock records messages without sending. For real delivery:
EMAIL_PROVIDER=mock
# RESEND_API_KEY=
# EMAIL_FROM_ADDRESS=hello@$DOMAIN
# Demo website for Website Intelligence (hackathon demo). Turn off for real customers.
DEMO_MODE=1
EOS
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
fi

echo "==> Nginx + TLS"
sed "s/app.example.com/$DOMAIN/g" "$(dirname "$0")/nginx.conf" > /etc/nginx/sites-available/revenuepilot
ln -sf /etc/nginx/sites-available/revenuepilot /etc/nginx/sites-enabled/revenuepilot
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || echo "!! certbot failed: point the DNS A record for $DOMAIN at this server, then re-run: certbot --nginx -d $DOMAIN"

echo "==> PM2 (boot start + log rotation)"
sudo -u "$APP_USER" pm2 install pm2-logrotate >/dev/null
sudo -u "$APP_USER" pm2 set pm2-logrotate:max_size 20M >/dev/null
sudo -u "$APP_USER" pm2 set pm2-logrotate:retain 14 >/dev/null
sudo -u "$APP_USER" pm2 set pm2-logrotate:compress true >/dev/null
env PATH="$PATH" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null

echo "==> Nightly database backup (03:15, 14 days retained)"
install -m 755 "$(dirname "$0")/backup.sh" /usr/local/bin/revenuepilot-backup
cat > /etc/cron.d/revenuepilot-backup <<EOS
15 3 * * * $APP_USER APP_DIR=$APP_DIR /usr/local/bin/revenuepilot-backup >> /var/log/revenuepilot-backup.log 2>&1
EOS

cat <<EOS

Done. Secrets: $SECRETS (root only). API config: $ENV_FILE
Next, as $APP_USER, from $APP_DIR:
  git clone <your repo> .   (or copy the code here)
  bash deploy/deploy.sh
Then open https://$DOMAIN
EOS
