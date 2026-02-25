require('dotenv').config();

const express = require('express');
const OpenAI = require('openai');
const pkg = require('./package.json');

const app = express();
app.use(express.json({ limit: '1mb' }));

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function extractOutputText(resp) {
  return (resp && resp.output_text ? String(resp.output_text) : '').trim();
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/ping', (_req, res) => res.json({ ok: true }));
app.get('/hello', (_req, res) => res.json({ ok: true }));
app.get('/version', (_req, res) => res.json({ version: pkg.version }));

app.post('/orchestrate', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: "Missing 'text'" });

    const system = [
      "YOU MUST RETURN ONLY VALID JSON. No markdown. No extra text. No code fences.",
      '{ "intent":"infra|construction|finance|legal|general", "summary":"string", "actions":["string"], "next_step":"string" }'
    ].join("\n");

    const input = [
      { role: "system", content: [{ type: "input_text", text: system }] },
      { role: "user", content: [{ type: "input_text", text: `Message:\n${text}` }] }
    ];

    const resp = await client.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      input,
      text: { format: { type: 'text' } }
    });

    const raw = extractOutputText(resp);

    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = {
        intent: "general",
        summary: raw ? raw.slice(0, 200) : "Empty output",
        actions: [],
        next_step: "Clarifie ta demande."
      };
    }

    return res.json(obj);
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`orchestrator listening on http://${HOST}:${PORT}`);
});
