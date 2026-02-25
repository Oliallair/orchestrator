"use strict";

require("dotenv").config({ path: "/opt/orchestrator/.env", override: true });
const TelegramBot = require("node-telegram-bot-api");
const { runCommand } = require("./src/executor");

const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
if (!token) {
  console.error("ERROR: Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const ADMIN_CHAT_ID = 5233465884;
const bot = new TelegramBot(token, { polling: true });

async function reply(chatId, text) {
  // Telegram limite ~4096 chars
  const chunk = String(text || "").slice(0, 3800);
  return bot.sendMessage(chatId, chunk || "—");
}

async function gitStatus() {
  return runCommand({ cmd: "git", args: ["status", "--porcelain=v1", "-b"], cwd: "/opt/orchestrator" });
}

async function gitDiff() {
  // diff compact et safe
  return runCommand({ cmd: "git", args: ["diff", "--stat"], cwd: "/opt/orchestrator" });
}

async function gitDiffFull() {
  // Full diff (peut être long), on limite à 3800 chars côté reply()
  return runCommand({ cmd: "git", args: ["diff"], cwd: "/opt/orchestrator" });
}

async function gitCommit(message) {
  // add + commit (simple)
  // 1) git add -A
  const addRes = await runCommand({ cmd: "git", args: ["add", "-A"], cwd: "/opt/orchestrator" });
  if (!addRes.ok) return { ok: false, step: "git add -A", ...addRes };

  // 2) git commit -m
  const commitRes = await runCommand({ cmd: "git", args: ["commit", "-m", message], cwd: "/opt/orchestrator" });
  return { ok: commitRes.ok, step: "git commit", ...commitRes };
}

bot.on("message", async (msg) => {
  const chatId = msg.chat?.id;
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  if (!chatId || !text) return;

  // 🔒 Access control
  if (chatId !== ADMIN_CHAT_ID) {
    return reply(chatId, "⛔ Accès refusé.");
  }

  // ✅ /git status
  if (text === "/git status") {
    const r = await gitStatus();
    const out = (r.stdout || "").trim();
    const err = (r.stderr || "").trim();
    return reply(chatId, `📌 /git status\n\n${out || "—"}\n\n${err ? "ERR:\n" + err : ""}`);
  }

  // ✅ /git diff (stat)
  if (text === "/git diff") {
    const r = await gitDiff();
    const out = (r.stdout || "").trim();
    const err = (r.stderr || "").trim();
    return reply(chatId, `📌 /git diff (stat)\n\n${out || "—"}\n\n${err ? "ERR:\n" + err : ""}`);
  }

  // ✅ /git diff full
  if (text === "/git diff full") {
    const r = await gitDiffFull();
    const out = (r.stdout || "").trim();
    const err = (r.stderr || "").trim();
    return reply(chatId, `📌 /git diff (full)\n\n${out || "—"}\n\n${err ? "ERR:\n" + err : ""}`);
  }

  // ✅ /git commit <message>
  if (text.startsWith("/git commit ")) {
    const message = text.slice("/git commit ".length).trim();

    if (!message) return reply(chatId, "⛔ Message de commit manquant. Exemple: /git commit fix: update telegram commands");
    if (message.length > 120) return reply(chatId, "⛔ Message trop long (max 120 chars).");

    const r = await gitCommit(message);
    const out = (r.stdout || "").trim();
    const err = (r.stderr || "").trim();

    if (!r.ok) {
      return reply(chatId, `❌ Commit failed (${r.step})\nCMD: ${r.cmd}\n\nSTDOUT:\n${out || "—"}\n\nSTDERR:\n${err || "—"}`);
    }

    return reply(chatId, `✅ Commit OK\n\n${out || "—"}`);
  }

  // (optionnel) garder /run pour debug rapide, mais pas obligatoire
  if (text.startsWith("/run ")) {
    const parts = text.slice(5).trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    const blocked = ["rm", "shutdown", "reboot", "mkfs", "dd", "kill", "pkill", "poweroff", "chmod", "chown"];
    if (!cmd || blocked.includes(cmd)) return reply(chatId, "⛔ Commande refusée.");

    const r = await runCommand({ cmd, args, cwd: "/opt/orchestrator", timeoutMs: 120000 });
    const out = (r.stdout || "—").trim();
    const err = (r.stderr || "—").trim();

    return reply(chatId, `🛠 CMD: ${r.cmd}\nOK: ${r.ok} | CODE: ${r.code} | TIMEOUT: ${r.timedOut}\n\nSTDOUT:\n${out}\n\nSTDERR:\n${err}`);
  }

  return reply(chatId, "✅ Commandes:\n/git status\n/git diff\n/git diff full\n/git commit <message>\n/run <cmd> ...");
});

bot.on("polling_error", (e) => {
  console.error("POLLING_ERROR:", e?.response?.body || e);
});

bot.getMe()
  .then((me) => console.log("BOT_OK:", me.username))
  .catch((e) => console.error("getMe_error:", e?.response?.body || e));
