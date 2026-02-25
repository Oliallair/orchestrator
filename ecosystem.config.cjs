module.exports = {
  apps: [
    {
      name: "orchestrator",
      cwd: "/opt/orchestrator",
      script: "index.js",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
