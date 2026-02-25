const OpenAI = require("openai");

function safeJsonParse(raw) {
  if (!raw || typeof raw !== "string") return null;

  // 1) essaie direct
  try {
    return JSON.parse(raw);
  } catch (_) {}

  // 2) essaie d'extraire le premier bloc JSON { ... }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = raw.slice(start, end + 1);
    try {
      return JSON.parse(sliced);
    } catch (_) {}
  }

  return null;
}

function extractOutputText(resp) {
  // Compatible Responses API: join all output_text blocks
  const out = [];
  if (!resp || !Array.isArray(resp.output)) return "";
  for (const item of resp.output) {
    if (item && item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c && c.type === "output_text" && typeof c.text === "string") {
          out.push(c.text);
        }
      }
    }
  }
  return out.join("\n").trim();
}

function normalize(obj) {
  const out = obj && typeof obj === "object" ? obj : {};

  if (!out.intent) out.intent = "general";
  if (!out.summary) out.summary = "Reçu.";
  if (!Array.isArray(out.actions)) out.actions = [];
  if (!out.next_step) out.next_step = "Dis-moi ton objectif et je déroule le plan.";

  // borne actions 0..6
  out.actions = out.actions.slice(0, 6).map((x) => String(x));

  return out;
}

async function aiOrchestrate({ text, logger }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  const model = process.env.OPENAI_MODEL || "gpt-4o-2024-08-06";
  const client = new OpenAI({ apiKey });

  // ⚠️ Français seulement + JSON strict
  const system = [
    "Tu es le conseiller exécutif stratégique 10X d’Olivier Allaire.",
    "Langue: FRANÇAIS SEULEMENT.",
    "Style: brutalement lucide, zéro fluff, tu structures et tu tranches.",
    "",
    "Tu couvres: chantier (béton/cimentier-applicateur), QC/livraison, direction construction, gestion d’entreprise, KPI/coûts/temps/risques, stratégie, et finance/investissement/crypto.",
    "",
    "Toujours analyser implicitement: Argent, Temps, Énergie, Structure, Dépendance à Olivier, Effet levier réel.",
    "Tu détectes: ego, peur, mode sauveur, contrôle inutile, fatigue décisionnelle.",
    "",
    "IMPORTANT: Tu réponds UNIQUEMENT avec un JSON valide. AUCUN markdown. AUCUN texte hors JSON.",
    "Schéma strict:",
    '{ "intent":"infra|construction|finance|legal|general", "summary":"string", "actions":["string"], "next_step":"string" }',
    "",
    "Règles:",
    "- summary: 1-2 phrases, vérité brute.",
    "- actions: 0 à 6 étapes concrètes, mesurables si possible (coûts/temps/risques).",
    "- next_step: 1 seule action immédiate, courte.",
  ].join("\n");

  const user = `Message:\n${String(text || "").trim()}`;

  try {
    const resp = await client.responses.create({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content: [{ type: "input_text", text: user }] },
      ],
      // On veut du texte brut (mais JSON à l'intérieur)
      text: { format: { type: "text" } },
    });

    const raw = extractOutputText(resp);

    // Log du raw (tronqué) pour debug
    logger && logger.info({ rawPreview: (raw || "").slice(0, 500) }, "ai_raw_preview");

    const parsed = safeJsonParse(raw);
    if (!parsed) {
      // fallback safe en JSON (pour ne jamais planter Telegram)
      return normalize({
        intent: "general",
        summary: "Réponse IA invalide (JSON non parsable).",
        actions: ["Corriger le prompt ou forcer une sortie JSON stricte côté modèle."],
        next_step: "Réessaie avec une question plus précise (contexte + contrainte).",
      });
    }

    return normalize(parsed);
  } catch (err) {
    logger && logger.error({ err: err.message }, "ai_error");

    // fallback JSON pour éviter "Erreur AI."
    return normalize({
      intent: "general",
      summary: "Erreur côté IA (clé/modèle/quota/réseau).",
      actions: [
        "Vérifier OPENAI_API_KEY (valide, pas expirée).",
        "Vérifier le modèle OPENAI_MODEL dans .env.",
        "Vérifier quota/facturation si applicable.",
        "Regarder les logs PM2 pour le détail.",
      ],
      next_step: "Ouvre les logs PM2 et copie-moi la ligne ai_error.",
    });
  }
}

module.exports = { aiOrchestrate };
