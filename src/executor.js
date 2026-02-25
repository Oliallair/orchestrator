const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

module.exports = { ensureDir };
