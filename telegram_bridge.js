"use strict";

require("dotenv").config({ path: "/opt/orchestrator/.env", override: true });

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");
const { runCommand } = require("./src/executor");

const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const ADMIN_CHAT_ID = 5233465884;

const REPO_DIR = "/opt/orchestrator";
const WORKSPACE_DIR = path.join(REPO_DIR, "workspace");

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();
const ai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const bot = new TelegramBot(token, { polling: true });

function reply(chatId, text) {
  return bot.sendMessage(chatId, String(text).slice(0, 3900));
}

function clamp(s, n) {
  const t = String(s || "");
  return t.length > n ? t.slice(0, n) + "\n…(truncated)…" : t;
}

async function gitCommit(message) {
  await runCommand({ cmd: "git", args: ["add", "-A"], cwd: REPO_DIR });
  return runCommand({ cmd: "git", args: ["commit", "-m", message], cwd: REPO_DIR });
}

async function runPatchTests() {
  const checks = [];

  async function run(name, cmd, args) {
    const r = await runCommand({ cmd, args, cwd: REPO_DIR });
    checks.push({
      name,
      ok: r.ok,
      code: r.code,
      stdout: clamp(r.stdout, 800),
      stderr: clamp(r.stderr, 800),
    });
  }

  await run("curl /health", "bash", ["-lc", "curl -s http://127.0.0.1:3000/health"]);
  await run("curl /version", "bash", ["-lc", "curl -s http://127.0.0.1:3000/version"]);

  return checks;
}

let pendingPatch = null;

bot.on("message", async (msg) => {
  const chatId = msg.chat?.id;
  const text = msg.text?.trim();

  if (!chatId || !text) return;
  if (chatId !== ADMIN_CHAT_ID) return reply(chatId, "⛔ Accès refusé.");

  // ----- EXACT PATCH COMMANDS FIRST -----
  if (text === "/patch cancel") {
    pendingPatch = null;
    return reply(chatId, "✅ Patch annulé.");
  }

  if (text === "/patch test") {
    const tests = await runPatchTests();
    let out = "🧪 Tests:\n";
    for (const t of tests) {
      out += `\n- ${t.name}: ok=${t.ok} code=${t.code}\n`;
      if (t.stdout) out += `  out: ${t.stdout}\n`;
      if (t.stderr) out += `  err: ${t.stderr}\n`;
    }
    return reply(chatId, out);
  }

  if (text === "/patch apply") {
    if (!pendingPatch) return reply(chatId, "⛔ Aucun patch en attente.");

    const filePath = path.join(REPO_DIR, pendingPatch.file);
    fs.writeFileSync(filePath, pendingPatch.content, "utf8");

    await gitCommit(pendingPatch.message || "feat: apply patch");

    await runCommand({ cmd: "pm2", args: ["restart", "orchestrator"], cwd: REPO_DIR });

    pendingPatch = null;
    return reply(chatId, "✅ Patch appliqué et orchestrator redémarré.");
  }

  // ----- SIMPLE PATCH (HELLO ONLY FOR NOW) -----
  if (text.startsWith("/patch ")) {
    const instruction = text.slice(7).trim();

    if (!instruction.toLowerCase().includes("/hello")) {
      return reply(chatId, "⚠️ Pour l’instant seul /hello est supporté.");
    }

    const indexPath = path.join(REPO_DIR, "index.js");
    const original = fs.readFileSync(indexPath, "utf8");

    if (original.includes("app.get('/hello'")) {
      return reply(chatId, "ℹ️ /hello existe déjà.");
    }

    const updated = original.replace(
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      "app.get('/health', (_req, res) => res.json({ ok: true }));\napp.get('/hello', (_req, res) => res.json({ ok: true }));"
    );

    pendingPatch = {
      file: "index.js",
      content: updated,
      message: "feat: add /hello endpoint"
    };

    return reply(chatId, "🧩 Patch prêt. Tape /patch apply pour appliquer.");
  }

  // ----- RUN -----
  if (text.startsWith("/run ")) {
    const parts = text.slice(5).split(" ");
    const cmd = parts[0];
    const args = parts.slice(1);

    const r = await runCommand({ cmd, args, cwd: REPO_DIR });

    return reply(
      chatId,
      `CMD: ${cmd}\nOK=${r.ok} CODE=${r.code}\n\nOUT:\n${r.stdout}\n\nERR:\n${r.stderr}`
    );
  }

  return reply(chatId, "Commandes:\n/patch ...\n/patch apply\n/patch test\n/patch cancel\n/run ...");
});

bot.getMe().then(me => console.log("BOT_OK:", me.username));
