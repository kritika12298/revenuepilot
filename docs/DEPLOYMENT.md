# Deploying to a GoDaddy VPS

Target: a GoDaddy VPS running Ubuntu 22.04 or 24.04 (2 vCPU / 4 GB RAM is plenty), with a domain such as `app.example.com` whose A record points at the server.

```
Internet ─▶ :443 Nginx ─┬─ static React build (apps/web/dist)
                         ├─ /api/*  ─▶ 127.0.0.1:4000  API (PM2 cluster ×2)
                         └─ /f/*    ─▶ SPA (frameable, for the GoDaddy site embed)
           127.0.0.1:5432 PostgreSQL     127.0.0.1:6379 Redis (password)     worker (PM2)
           ufw: allow 22, 80, 443 only
```

## 1. Provision (once, as root)

```bash
git clone <your repo> /var/www/revenuepilot
cd /var/www/revenuepilot
sudo DOMAIN=app.example.com EMAIL=you@example.com bash deploy/setup-vps.sh
```

`deploy/setup-vps.sh` is idempotent. It:

- installs Node 22, PostgreSQL, Redis, Nginx, PM2 and Certbot;
- configures **ufw** to deny incoming traffic except SSH, HTTP and HTTPS;
- binds **PostgreSQL** to `localhost` and creates the `revenuepilot` role and database with a generated password;
- binds **Redis** to `127.0.0.1` with `requirepass`, `protected-mode yes` and `maxmemory-policy noeviction` (BullMQ needs this);
- generates `JWT_SECRET`, `INTEGRATIONS_ENCRYPTION_KEY` and the database and Redis passwords into `/etc/revenuepilot/secrets.env` (root, mode 600);
- writes `apps/api/.env` (mode 600) **once**. After that you edit it yourself;
- installs the Nginx site from `deploy/nginx.conf` and obtains a **Let's Encrypt** certificate (`certbot --nginx --redirect`; renewal runs from the certbot systemd timer);
- configures PM2 to start on boot and installs **pm2-logrotate** (20 MB per file, 14 files kept, compressed);
- installs a nightly **backup** cron job (03:15 UTC, 14 days kept).

Hand the directory to the app user: `chown -R revenuepilot:revenuepilot /var/www/revenuepilot`.

## 2. Configure

Edit `/var/www/revenuepilot/apps/api/.env`:

| Variable | Production value |
|---|---|
| `ANTHROPIC_API_KEY` | Enables live Claude (`AI_MODE=auto`). Without it the agents run in mock mode, and the UI says so |
| `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS` | Real email delivery. The sender must be on a domain verified in Resend |
| `DEMO_MODE` | `1` keeps the bundled demo website. Set `0` for real customers |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional Google Calendar. Redirect URI: `https://<domain>/api/integrations/google/callback` |
| `INBOUND_REPLY_ADDRESS`, `INBOUND_WEBHOOK_SECRET` | Optional automatic reply matching |
| `OPS_TOKEN` | Optional queue monitoring at `/ops/queues`, reachable only from the server (`curl -H "Authorization: Bearer …" http://127.0.0.1:4000/ops/queues`) |

The API refuses to start in production if `JWT_SECRET` is still the placeholder or `INTEGRATIONS_ENCRYPTION_KEY` is missing.

## 3. Deploy

As the app user, from the repository root:

```bash
sudo -iu revenuepilot
cd /var/www/revenuepilot
SEED=1 bash deploy/deploy.sh     # first deploy, with the demo data; afterwards just: bash deploy/deploy.sh
```

`deploy.sh` runs these steps in order:

1. `git pull --ff-only`
2. `npm ci`
3. `prisma migrate deploy`
4. Optionally the seed
5. `vite build`
6. `pm2 reload` (zero downtime for the API cluster; the worker drains in-flight jobs for up to 30 s)
7. `pm2 save`
8. Waits for `/readyz`

Restart without rebuilding, for example after editing `.env`:

```bash
bash deploy/restart.sh          # both processes
bash deploy/restart.sh api      # or worker
```

## 4. Operate

| Task | Command |
|---|---|
| Status | `pm2 status` |
| Logs (JSON, pino) | `pm2 logs revenuepilot-api` / `pm2 logs revenuepilot-worker`; files are in `~/.pm2/logs` (rotated) |
| Nginx logs | `/var/log/nginx/revenuepilot.access.log` (query strings and unsubscribe tokens removed), `error.log` |
| Health | `curl https://<domain>/readyz` |
| Manual backup | `sudo -u revenuepilot APP_DIR=/var/www/revenuepilot revenuepilot-backup` |
| Restore | `pg_restore --clean --if-exists -d "postgresql://…/revenuepilot" /var/backups/revenuepilot/<file>.dump` |
| Certificates | `sudo certbot renew --dry-run` |

Copy backups off the VPS as well (object storage via `rclone`, for example). A backup on the same disk does not survive losing the server.

## Security checklist

- [ ] `sudo ufw status` shows only 22, 80 and 443.
- [ ] `ss -tlnp` shows 5432, 6379 and 4000 bound to `127.0.0.1` only.
- [ ] `apps/api/.env` and `/etc/revenuepilot/secrets.env` have mode 600. Neither is in git (`.gitignore` covers `.env*`).
- [ ] SSH key login only (`PasswordAuthentication no`). Consider `fail2ban`.
- [ ] `DEMO_MODE=0` once real customers use the system.
- [ ] Unattended security upgrades are enabled (`sudo dpkg-reconfigure -plow unattended-upgrades`).
