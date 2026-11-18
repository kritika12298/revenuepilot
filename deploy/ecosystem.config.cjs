// PM2 process file: `pm2 start deploy/ecosystem.config.cjs --env production`
// The API and the worker are separate processes so a slow AI draft or email
// retry never blocks HTTP requests. Both read apps/api/.env.
module.exports = {
  apps: [
    {
      name: 'revenuepilot-api',
      script: 'apps/api/src/server.js',
      instances: 2,
      exec_mode: 'cluster',
      env_production: { NODE_ENV: 'production', TRUST_PROXY: '1' },
      max_memory_restart: '512M',
      kill_timeout: 15000,
    },
    {
      name: 'revenuepilot-worker',
      script: 'apps/api/src/worker.js',
      instances: 1,
      exec_mode: 'fork',
      env_production: { NODE_ENV: 'production' },
      max_memory_restart: '512M',
      // Give in-flight jobs time to finish on deploy (worker waits up to 30s).
      kill_timeout: 35000,
    },
  ],
};
