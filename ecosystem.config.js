// pm2 process definition. Secrets are NOT listed here: HL_TESTNET_PRIVATE_KEY is inherited from the
// environment of the shell that runs `./qs.sh start|restart`; WEBHOOK_SECRET/ADMIN_TOKEN/HL_ACCOUNT_ADDRESS
// are loaded by the server from .env.
module.exports = {
  apps: [{
    name: 'quantsignal',
    script: 'server/index.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 1000,
    min_uptime: '10s',
    restart_delay: 3000,
    exp_backoff_restart_delay: 2000,
    max_memory_restart: '400M',
    out_file: __dirname + '/logs/engine.out.log',
    error_file: __dirname + '/logs/engine.err.log',
    merge_logs: true,
    time: false,
  }, {
    name: 'quantsignal-tunnel',
    script: __dirname + '/scripts/tunnel.sh',
    interpreter: 'bash',
    autorestart: true,
    restart_delay: 5000,
    out_file: __dirname + '/logs/tunnel.log',
    error_file: __dirname + '/logs/tunnel.log',
    merge_logs: true,
    filter_env: ['HL_', 'WEBHOOK_', 'ADMIN_'],
  }],
};
