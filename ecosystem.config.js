module.exports = {
  apps: [
    {
      name: "orchestrator",
      script: "index.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,

      max_restarts: 5,
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,

      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "3000"
      }
    }
  ]
};
