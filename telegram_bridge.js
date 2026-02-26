"use strict";

const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

const REPO_DIR = process.env.REPO_DIR || path.resolve(__dirname);

const envPaths = [];
if (process.env.DOTENV_PATH) envPaths.push(process.env.DOTENV_PATH);
envPaths.push(path.join(__dirname, ".env"));
envPaths.push(path.join(REPO_DIR, ".env"));

const envPath = envPaths.find((p) => fs.existsSync(p));
if (envPath) {
  dotenv.config({ path: envPath, override: true });
} else {
  dotenv.config();
}

const crypto = require("crypto");

const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");
const { runCommand } = require("./src/executor");
const { aiOrchestrate } = require(path.join(__dirname, "src", "ai"));

const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
if (!token) {
  console.error("ERROR: Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

// 🔒 Mets ton chat_id admin ici
const ADMIN_CHAT_ID = 5233465884;
const WORKSPACE_DIR = path.join(REPO_DIR, "workspace");

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();
const ai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const bot = new TelegramBot(token, { polling: true });
const lastMsgAtByChatId = new Map();

// ---------------- helpers ----------------
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function rid() {
  return crypto.randomBytes(4).toString("hex");
}

async function reply(chatId, text) {
  const msg = String(text || "");
  return bot.sendMessage(chatId, msg.slice(0, 3900) || "—");
}

function clamp(s, n) {
  const t = String(s || "");
  return t.length > n ? t.slice(0, n) + "\n…(truncated)…" : t;
}

function safeRelPath(p) {
  const cleaned = String(p || "").replace(/^(\.\/)+/, "").trim();
  if (!cleaned) throw new Error("Empty path");
  if (cleaned.includes("..")) throw new Error("Path traversal refused");
  if (cleaned.startsWith("/")) throw new Error("Absolute path refused");
  return cleaned;
}

function isForbiddenPath(rel) {
  const p = safeRelPath(rel);
  if (p === ".env" || p.startsWith(".env.")) return true;

  const badPrefixes = [".git/", "node_modules/", "logs/", "workspace/"];
  return badPrefixes.some((bp) => p.startsWith(bp));
}

function absInRepo(rel) {
  const p = safeRelPath(rel);
  const full = path.resolve(REPO_DIR, p);
  const root = path.resolve(REPO_DIR) + path.sep;
  if (!full.startsWith(root)) throw new Error("Outside repo refused: " + rel);
  return full;
}

function fileExists(rel) {
  try {
    const full = absInRepo(rel);
    return fs.existsSync(full) && fs.statSync(full).isFile();
  } catch {
    return false;
  }
}

function readText(rel, maxBytes = 180_000) {
  const full = absInRepo(rel);
  const buf = fs.readFileSync(full);
  if (buf.length > maxBytes) throw new Error(`File too large: ${rel} (${buf.length} bytes)`);
  return buf.toString("utf8");
}

function writeTextAbs(absPath, text) {
  ensureDir(path.dirname(absPath));
  fs.writeFileSync(absPath, String(text), "utf8");
}

// ---------------- git ops ----------------
async function gitStatus() {
  return runCommand({ cmd: "git", args: ["status", "--porcelain=v1", "-b"], cwd: REPO_DIR });
}
async function gitDiffStat() {
  return runCommand({ cmd: "git", args: ["diff", "--stat"], cwd: REPO_DIR });
}
async function gitDiffFull() {
  return runCommand({ cmd: "git", args: ["diff"], cwd: REPO_DIR });
}
async function gitCommit(message) {
  const addRes = await runCommand({ cmd: "git", args: ["add", "-A"], cwd: REPO_DIR });
  if (!addRes.ok) return { ok: false, step: "git add -A", ...addRes };
  const commitRes = await runCommand({ cmd: "git", args: ["commit", "-m", message], cwd: REPO_DIR });
  return { ok: commitRes.ok, step: "git commit", ...commitRes };
}

// ---------------- /run security ----------------
function isRunBlocked(cmd, args) {
  const blockedCmds = [
    "rm", "shutdown", "reboot", "mkfs", "dd", "kill", "pkill", "poweroff", "chmod", "chown",
    "printenv", "env"
  ];
  if (!cmd) return true;
  if (blockedCmds.includes(cmd)) return true;

  const joined = [cmd, ...(args || [])].join(" ");
  if (joined.includes(".env")) return true;

  return false;
}

// ---------------- PATCH (JSON actions → apply) ----------------
let pendingPatch = null;

function applyOpsToContent(original, ops) {
  let s = String(original);

  for (const op of ops) {
    const kind = String(op.op || "").trim();
    const match = op.match != null ? String(op.match) : null;
    const text = op.text != null ? String(op.text) : "";

    if (kind === "insert_after") {
      if (!match) throw new Error("insert_after requires match");
      const idx = s.indexOf(match);
      if (idx < 0) throw new Error("match not found for insert_after");
      const pos = idx + match.length;
      s = s.slice(0, pos) + text + s.slice(pos);
      continue;
    }

    if (kind === "insert_before") {
      if (!match) throw new Error("insert_before requires match");
      const idx = s.indexOf(match);
      if (idx < 0) throw new Error("match not found for insert_before");
      s = s.slice(0, idx) + text + s.slice(idx);
      continue;
    }

    if (kind === "replace_once") {
      if (!match) throw new Error("replace_once requires match");
      const idx = s.indexOf(match);
      if (idx < 0) throw new Error("match not found for replace_once");
      s = s.slice(0, idx) + text + s.slice(idx + match.length);
      continue;
    }

    if (kind === "append") {
      if (!s.endsWith("\n")) s += "\n";
      s += text;
      continue;
    }

    throw new Error("Unsupported op: " + kind);
  }

  return s;
}

async function makePreviewDiff(origAbs, newAbs) {
  const r = await runCommand({
    cmd: "git",
    args: ["diff", "--no-index", "--", origAbs, newAbs],
    cwd: REPO_DIR,
    timeoutMs: 120000
  });

  const ok = r.code === 0 || r.code === 1; // diff returns 1 when different (normal)
  return {
    ok,
    code: r.code,
    stdout: r.stdout || "",
    stderr: r.stderr || ""
  };
}

async function buildPatchFromAI(instruction) {
  if (!ai) throw new Error("OPENAI_API_KEY missing in .env (required for /patch)");

  // 👉 Pour commencer: on autorise seulement index.js (c’est la bonne pratique)
  const allowedFiles = ["index.js","telegram_bridge.js"];

  const fileContext = `FILE: index.js\n-----\n${readText("index.js")}\n-----\n`;

  const system = [
    "Return ONLY valid JSON. No markdown. No extra text.",
    "You are a coding agent. You MUST NOT output a diff.",
    "You must output JSON instructions for minimal edits.",
    "",
    "STRICT RULES:",
    `1) Only modify these files: ${allowedFiles.join(", ")}`,
    "2) Use ops: insert_after | insert_before | replace_once | append",
    "3) match must be an exact substring present in the file content",
    "4) Keep changes minimal; do NOT delete/replace large chunks",
    "",
    "JSON schema:",
    "{",
    '  \"commit_message\": \"<= 80 chars\",',
    '  \"notes\": \"short\",',
    '  \"files\": [',
    '    { \"path\": \"index.js\", \"ops\": [',
    '        {\"op\":\"insert_after\",\"match\":\"...\",\"text\":\"...\"}',
    "    ] }",
    "  ]",
    "}"
  ].join("\n");

  const user = [
    "INSTRUCTION:",
    instruction,
    "",
    "CURRENT FILE CONTENTS:",
    fileContext,
  ].join("\n");

  const input = [
    { role: "system", content: [{ type: "input_text", text: system }] },
    { role: "user", content: [{ type: "input_text", text: user }] }
  ];

  const resp = await ai.responses.create({
    model: OPENAI_MODEL,
    input,
    text: { format: { type: "text" } }
  });

  const raw = (resp && resp.output_text ? String(resp.output_text) : "").trim();

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("AI returned non-JSON. Raw: " + raw.slice(0, 250));
  }

  const commit_message = String(obj.commit_message || "feat: apply patch").slice(0, 80);
  const notes = String(obj.notes || "").slice(0, 220);

  const files = Array.isArray(obj.files) ? obj.files : [];
  if (files.length !== 1) throw new Error("Patch must target exactly 1 file (index.js).");

  const f0 = files[0] || {};
  const relPath = String(f0.path || "").trim();

  if (!allowedFiles.includes(relPath)) throw new Error("Only index.js is allowed.");
  if (isForbiddenPath(relPath)) throw new Error("Forbidden file path: " + relPath);
  if (!fileExists(relPath)) throw new Error("File not found: " + relPath);

  const ops = Array.isArray(f0.ops) ? f0.ops : [];
  if (ops.length < 1) throw new Error("No ops provided.");

  const original = readText(relPath);
  const updated = applyOpsToContent(original, ops);

  // Safety: avoid big shrink
  const origLines = original.split("\n").length;
  const newLines = updated.split("\n").length;
  if (origLines > 0 && newLines < origLines * 0.7) {
    throw new Error(`Refused: file too much smaller (orig=${origLines}, new=${newLines}).`);
  }

  ensureDir(WORKSPACE_DIR);
  const patchId = rid();
  const origAbs = path.join(WORKSPACE_DIR, `orig_${patchId}_${path.basename(relPath)}`);
  const newAbs = path.join(WORKSPACE_DIR, `new_${patchId}_${path.basename(relPath)}`);

  writeTextAbs(origAbs, original);
  writeTextAbs(newAbs, updated);

  const diff = await makePreviewDiff(origAbs, newAbs);
  if (!diff.ok) throw new Error("Diff preview failed: " + (diff.stderr || "unknown"));

  return {
    patchId,
    commit_message,
    notes,
    files: [{ path: relPath, origAbs, newAbs }],
    diffText: diff.stdout || "(no diff?)",
  };
}

async function applyPendingPatchAndCommit() {
  if (!pendingPatch) throw new Error("No pending patch.");

  for (const f of pendingPatch.files) {
    const repoAbs = absInRepo(f.path);
    const newContent = fs.readFileSync(f.newAbs, "utf8");
    fs.writeFileSync(repoAbs, newContent, "utf8");
  }

  const commitRes = await gitCommit(pendingPatch.commit_message || "feat: apply patch");
  if (!commitRes.ok) throw new Error("Commit failed: " + (commitRes.stderr || "unknown"));

  return commitRes;
}

// ---------------- PATCH TESTS (A2) ----------------
async function runPatchTests() {
  const checks = [];

  async function run(name, cmd, args) {
    const r = await runCommand({ cmd, args, cwd: REPO_DIR, timeoutMs: 120000 });
    checks.push({
      name,
      ok: r.ok,
      code: r.code,
      stdout: clamp((r.stdout || "").trim(), 1400),
      stderr: clamp((r.stderr || "").trim(), 1400),
    });
  }

  function curlRetryBash(curlCmd) {
    return `for i in {1..6}; do ${curlCmd} && exit 0; sleep 1; done; exit 1`;
  }

  await run("curl /health", "bash", ["-lc", curlRetryBash("curl -s http://127.0.0.1:3000/health")]);
  await run("curl /version", "bash", ["-lc", curlRetryBash("curl -s http://127.0.0.1:3000/version")]);

  await run(
    "curl /orchestrate",
    "bash",
    ["-lc", curlRetryBash("curl -s -X POST http://127.0.0.1:3000/orchestrate -H 'Content-Type: application/json' -d '{\"text\":\"ping\"}'")]
  );

  await run("pm2 list", "pm2", ["list"]);

  return checks;
}

// ---------------- handlers ----------------
bot.on("message", async (msg) => {
  const chatId = msg.chat?.id;
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  if (!text) return;
  if (!chatId) return;
  if (chatId !== ADMIN_CHAT_ID) {
    return reply(chatId, "⛔ Accès refusé.");
  }

  // ---------- Mode IA (texte sans /) ----------
  if (!text.startsWith("/")) {
    const last = lastMsgAtByChatId.get(chatId);
    if (last != null && Date.now() - last < 2000) {
      return reply(chatId, "⏳ Attends 2 secondes");
    }
    lastMsgAtByChatId.set(chatId, Date.now());

    const shortGreetings = ["hello", "salut", "allo", "yo", "test", "ok", "hey"];
    if (shortGreetings.includes(text.toLowerCase()) || text.length < 5) {
      return reply(
        chatId,
        "👋 Salut! Dis-moi ce que tu veux faire:\n1) /git status\n2) /patch <instruction>\n3) Pose ta question (ex: 'résume ce log' ou 'quoi faire ensuite')"
      );
    }
    try {
      const out = await aiOrchestrate({ text, logger: console });
      const lines = [
        "📌 " + (out.summary || "—"),
        "",
        "📋 Actions:",
        ...(Array.isArray(out.actions) && out.actions.length ? out.actions.map((a) => "• " + a) : ["—"]),
        "",
        "➡️ " + (out.next_step || "—"),
      ];
      const formatted = lines.join("\n");
      await reply(chatId, formatted.length > 4000 ? formatted.slice(0, 4000) + "\n…" : formatted);
    } catch (err) {
      console.error(err);
      await reply(chatId, "❌ Désolé, une erreur s'est produite.");
    }
    return;
  }

  // ---------- /git ----------
  if (text === "/git status") {
    const r = await gitStatus();
    return reply(chatId, `📌 /git status\n\n${(r.stdout || "—").trim()}`);
  }
  if (text === "/git diff") {
    const r = await gitDiffStat();
    return reply(chatId, `📌 /git diff (stat)\n\n${(r.stdout || "—").trim()}`);
  }
  if (text === "/git diff full") {
    const r = await gitDiffFull();
    return reply(chatId, `📌 /git diff (full)\n\n${clamp((r.stdout || "—").trim(), 3500)}`);
  }
  if (text.startsWith("/git commit ")) {
    const message = text.slice("/git commit ".length).trim();
    if (!message) return reply(chatId, "⛔ Message manquant. Ex: /git commit fix: update bot");

    const r = await gitCommit(message);
    if (!r.ok) return reply(chatId, `❌ Commit failed (${r.step})\n\n${(r.stderr || "—").trim()}`);

    return reply(chatId, `✅ Commit OK\n\n${(r.stdout || "—").trim()}`);
  }

  // ---------- /patch (FIXED ORDER) ----------
  if (text === "/patch cancel") {
    pendingPatch = null;
    return reply(chatId, "✅ Patch annulé.");
  }

  if (text === "/patch test") {
    try {
      const tests = await runPatchTests();
      const lines = ["🧪 Patch tests:"];
      for (const t of tests) {
        lines.push(`- ${t.name}: ok=${t.ok} code=${t.code}`);
        if (t.stdout) lines.push(`  out: ${clamp(t.stdout, 800)}`);
        if (t.stderr) lines.push(`  err: ${clamp(t.stderr, 800)}`);
      }
      return reply(chatId, lines.join("\n"));
    } catch (e) {
      return reply(chatId, "❌ /patch test error: " + String(e.message || e));
    }
  }

  if (text === "/patch apply") {
    if (!pendingPatch) return reply(chatId, "⛔ Aucun patch en attente. Utilise: /patch <instruction>");

    try {
      const commitRes = await applyPendingPatchAndCommit();
      const rRestart = await runCommand({ cmd: "pm2", args: ["restart", "orchestrator"], cwd: REPO_DIR, timeoutMs: 120000 });

      const tests = await runPatchTests();

      const lines = [];
      lines.push(`✅ Patch applied & committed: ${pendingPatch.patchId}`);
      lines.push(`Commit msg: ${pendingPatch.commit_message}`);
      lines.push("");
      lines.push(`PM2 restart orchestrator: ok=${rRestart.ok} code=${rRestart.code}`);
      if ((rRestart.stderr || "").trim()) lines.push("ERR:\n" + clamp(rRestart.stderr.trim(), 600));
      lines.push("");
      lines.push("🧪 Tests:");
      for (const t of tests) {
        lines.push(`- ${t.name}: ok=${t.ok} code=${t.code}`);
        if (t.stdout) lines.push(`  out: ${clamp(t.stdout, 600)}`);
        if (t.stderr) lines.push(`  err: ${clamp(t.stderr, 600)}`);
      }
      lines.push("");
      lines.push("Git commit output:");
      lines.push(clamp((commitRes.stdout || "—").trim(), 800));

      pendingPatch = null;
      return reply(chatId, lines.join("\n"));
    } catch (e) {
      pendingPatch = null;
      return reply(chatId, "❌ /patch apply error: " + String(e.message || e));
    }
  }

  if (text.startsWith("/patch ")) {
    const instruction = text.slice(7).trim();
    if (!instruction) return reply(chatId, "⛔ Utilise: /patch <instruction>");

    try {
      await reply(chatId, "⏳ Je prépare un patch SAFE (JSON actions)…");

      const built = await buildPatchFromAI(instruction);

      pendingPatch = {
        patchId: built.patchId,
        commit_message: built.commit_message,
        notes: built.notes,
        files: built.files,
        createdAt: Date.now(),
        diffText: built.diffText,
      };

      const header =
        `🧩 Patch ID: ${pendingPatch.patchId}\n` +
        `Notes: ${pendingPatch.notes || "—"}\n` +
        `Commit: ${pendingPatch.commit_message}\n\n`;

      return reply(
        chatId,
        header +
          clamp(pendingPatch.diffText, 3200) +
          `\n\n✅ Pour appliquer: /patch apply\n🧪 Pour tester: /patch test\n❌ Pour annuler: /patch cancel`
      );
    } catch (e) {
      pendingPatch = null;
      return reply(chatId, "❌ /patch error: " + String(e.message || e));
    }
  }

  // ---------- /run ----------
  if (text.startsWith("/run ")) {
    const parts = text.slice(5).trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    if (isRunBlocked(cmd, args)) return reply(chatId, "⛔ Commande refusée.");

    const r = await runCommand({ cmd, args, cwd: REPO_DIR, timeoutMs: 120000 });
    return reply(
      chatId,
      `🛠 CMD: ${r.cmd}\nOK: ${r.ok} | CODE: ${r.code} | TIMEOUT: ${r.timedOut}\n\nSTDOUT:\n${(r.stdout || "—").trim()}\n\nSTDERR:\n${(r.stderr || "—").trim()}`
    );
  }

  return reply(
    chatId,
    "✅ Commandes:\n" +
      "/git status\n" +
      "/git diff\n" +
      "/git diff full\n" +
      "/git commit <message>\n" +
      "/patch <instruction>\n" +
      "/patch apply\n" +
      "/patch test\n" +
      "/patch cancel\n" +
      "/run <cmd> ..."
  );
});

bot.on("polling_error", (e) => {
  console.error("POLLING_ERROR:", e?.response?.body || e);
});

bot.getMe()
  .then((me) => console.log("BOT_OK:", me.username))
  .catch((e) => console.error("getMe_error:", e?.response?.body || e));
