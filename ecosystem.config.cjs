/**
 * PM2 process definition for the Telegram Pi Gateway.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs   # start (or apply the config to a running app)
 *   pm2 save                         # persist the process list across pm2 daemon restarts
 *   pm2 resurrect                    # restore it after a reboot
 *
 * NOTE: the file uses the .cjs extension because the package is ESM
 * ("type": "module") and pm2 loads ecosystem files with require().
 *
 * Secrets (TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID, WORK_DIR) are NOT
 * stored here on purpose: they stay in the environment pm2 inherited when the
 * process was first started. Start it from a shell that exports them.
 */
module.exports = {
  apps: [
    {
      name: "telegram-pi-gateway",
      script: "/Users/marthin.lachira/.bun/bin/bun",
      args: "src/index.ts",
      cwd: __dirname,
      interpreter: "none",
      exec_mode: "fork",
      instances: 1,

      // Restart policy: the gateway must come back on its own after a crash.
      //   autorestart    -> restart the process when it exits
      //   max_restarts   -> how many consecutive fast crashes are tolerated
      //                     (pm2 gives up permanently after this many)
      //   min_uptime     -> uptime below which a crash counts as "unstable"
      //   restart_delay  -> pause before the restart, avoids a tight crash loop
      autorestart: true,
      max_restarts: 1000,
      min_uptime: 1000,
      restart_delay: 2000,

      watch: false,
      env: {},
    },
  ],
};
