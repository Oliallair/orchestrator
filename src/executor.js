const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// Whitelist stricte (sécurité)
const ALLOW = {
  node: ["-v", "--version"],
  npm: ["ci", "install", "test", "run", "start", "audit"],
  git: ["status", "diff", "add", "commit", "checkout", "branch", "log", "show", "rev-parse", "reset", "pull"],
  pm2: ["status", "list", "restart", "reload", "logs", "save", "describe"],
  bash: ["-lc"], // utilisé seulement pour retry curl dans tests
  curl: [] // optionnel (si tu veux l'autoriser via runCommand direct)
};

function isAllowed(cmd, args = []) {
  if (!Object.prototype.hasOwnProperty.call(ALLOW, cmd)) return false;
  const allowedFirstArgs = ALLOW[cmd];

  // Si la commande autorise n'importe quel premier arg (liste vide), OK
  if (allowedFirstArgs.length === 0) return true;

  // Si pas d'args, on autorise seulement si la liste contient "" (pas le cas ici)
  if (args.length === 0) return false;

  // Autorise seulement si le 1er arg est permis (ex: git pull, npm ci, pm2 restart)
  return allowedFirstArgs.includes(args[0]);
}

function runCommand({ cmd, args = [], cwd = process.cwd(), timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    const safeCwd = path.resolve(cwd);

    if (!isAllowed(cmd, args)) {
      return resolve({
        ok: false,
        code: -1,
        timedOut: false,
        cmd: `${cmd} ${(args || []).join(" ")}`.trim(),
        cwd: safeCwd,
        stdout: "",
        stderr: `Command not allowed: ${cmd} ${(args || []).join(" ")}`.trim(),
      });
    }

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
