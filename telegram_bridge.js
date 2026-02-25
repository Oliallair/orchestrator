"use strict";

require("dotenv").config({ path: "/opt/orchestrator/.env", override: true });
const TelegramBot = require("node-telegram-bot-api");

const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
console.log("BOOT token_len=", token.length);

if (!token) {
  console.error("ERROR: Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

bot.on("message", async (msg) => {
  console.log("INCOMING:", {
    chat_id: msg.chat?.id,
    from: msg.from?.username,
    text: msg.text
  });

  if (msg.chat?.id && typeof msg.text === "string") {
    try {
      await bot.sendMessage(msg.chat.id, "✅ Reçu: " + msg.text);
    } catch (e) {
      console.error("sendMessage_error:", e?.response?.body || e);
    }
  }
});

bot.on("polling_error", (e) => {
  console.error("POLLING_ERROR:", e?.response?.body || e);
});

bot.getMe()
  .then((me) => console.log("BOT_OK:", me.username))
  .catch((e) => console.error("getMe_error:", e?.response?.body || e));
