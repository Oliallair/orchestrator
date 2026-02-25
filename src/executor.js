const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

module.exports = { ensureDir };

function runCommand({ cmd, args = [], cwd = process.cwd(), timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    const safeCwd = path.resolve(cwd);

    const child = spawn(cmd, args, { cwd: safeCwd, shell: false });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        timedOut,
        cmd: `${cmd} ${(args || []).join(" ")}`.trim(),
        cwd: safeCwd,
        stdout: stdout.slice(0, 4000),
        stderr: stderr.slice(0, 4000),
      });
    });
  });
}

module.exports = { ensureDir, runCommand };
