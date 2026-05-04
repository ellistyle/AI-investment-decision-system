module.exports = {
  apps: [
    {
      name: 'investment-system',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '~/.investment-system/logs/error.log',
      out_file: '~/.investment-system/logs/out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
