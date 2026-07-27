// Anthropic bridge: powers the in-app support conversation. When a user opens a
// ticket, Claude chats with them to clarify the request, then calls the
// `submit_ticket` tool once the demand is clear — that signal is what the
// support route turns into a BugReport + GitHub issue.
//
// Optional by design, same as github.js: with no ANTHROPIC_API_KEY the bridge
// is disabled and the support route falls back to a one-shot report. Native
// fetch only — no SDK dependency, matching github.js / push.js / routes/gifs.js.

const API = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

// Bound a runaway conversation: a hostile/looping client can't rack up calls.
export const MAX_TURNS = 24;
// Keep replies short — this is a focused triage chat, not an essay.
const MAX_TOKENS = 1024;

// Read env lazily so tests can toggle the bridge per-case.
function apiKey() {
  return process.env.ANTHROPIC_API_KEY || "";
}
function model() {
  return process.env.SUPPORT_MODEL || "claude-opus-4-8";
}

export function anthropicEnabled() {
  return Boolean(apiKey());
}

// French-first triage agent. Asks a few targeted questions, then finalizes.
const SYSTEM = `Tu es l'assistant de support de MurgaChat, un chat de type Slack (web, PWA, desktop Tauri, mobile). Tu dialogues en français avec un utilisateur qui signale un bug ou demande une amélioration.

Ton objectif : transformer une demande floue en un ticket clair, actionnable ET déjà classé pour l'équipe de développement. C'est toi qui réalises le tri : il n'y a aucune étape de classement ultérieure.

Déroulé :
- Pose des questions de clarification ciblées (étapes de reproduction, résultat attendu vs obtenu, plateforme, fréquence). Une à trois questions courtes à la fois, jamais un interrogatoire.
- Ne demande pas d'informations déjà fournies ou présentes dans le diagnostic joint.
- Reste concis et bienveillant. Ne promets pas de délai ni de correctif.

Dès que la demande est suffisamment précise pour qu'un développeur puisse agir (souvent après une ou deux questions), appelle l'outil submit_ticket. À la finalisation tu DOIS :
- structurer le corps en markdown avec ces sections : « Résumé », « Étapes de reproduction », « Résultat attendu vs obtenu », « Contexte » ;
- estimer la sévérité (faible / moyenne / élevée) ;
- déduire le domaine le plus probablement concerné (server / web / mobile / desktop) à partir de la plateforme et des symptômes.
N'attends pas une perfection : si l'utilisateur ne sait pas répondre ou répète, finalise avec ce que tu as. Si l'utilisateur le demande explicitement, finalise immédiatement.`;

// Single tool: Claude calls it to finalize. The input becomes the GitHub issue.
const SUBMIT_TOOL = {
  name: "submit_ticket",
  description:
    "Finalise le ticket de support une fois la demande suffisamment claire. Crée l'issue côté équipe.",
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Titre court et explicite du problème (sans préfixe).",
      },
      body: {
        type: "string",
        description:
          "Description structurée en français (markdown) avec les sections : Résumé, Étapes de reproduction, Résultat attendu vs obtenu, Contexte. Synthèse de la conversation.",
      },
      severity: {
        type: "string",
        enum: ["faible", "moyenne", "élevée"],
        description: "Sévérité estimée.",
      },
      domain: {
        type: "string",
        enum: ["server", "web", "mobile", "desktop"],
        description:
          "Composant le plus probablement concerné, déduit de la plateforme et des symptômes : server (backend), web (client web/PWA), mobile (app mobile), desktop (app Tauri).",
      },
    },
    required: ["title", "body"],
  },
};

// Truncate the logs we feed the model: recent breadcrumbs are the useful part,
// and the full buffer (≤100 KB) would bloat every turn's context.
const MAX_LOG_CONTEXT = 4000;

// Build the diagnostic block injected into the system prompt so Claude already
// knows the environment (platform, version, recent logs) and doesn't re-ask.
// Returns "" when nothing is attached. Goes in the system prompt — not the
// messages — so it never shows up in the transcript rendered to the user.
export function diagnosticContext({ appVersion, platform, diagnostics, logs } = {}) {
  const lines = [];
  if (platform) lines.push(`Plateforme : ${platform}`);
  if (appVersion) lines.push(`Version de l'app : ${appVersion}`);
  if (diagnostics && typeof diagnostics === "object") {
    for (const [k, v] of Object.entries(diagnostics)) {
      if (k === "platform" || k === "appVersion") continue; // déjà listés
      lines.push(`${k} : ${String(v).slice(0, 200)}`);
    }
  }

  let block = "";
  if (lines.length) {
    block +=
      "\n\n--- Diagnostic technique joint automatiquement au ticket ---\n" +
      "Ces informations proviennent de l'appareil de l'utilisateur. UTILISE-les et NE REDEMANDE PAS " +
      "ce qui y figure déjà (plateforme, version, état de connexion, etc.).\n" +
      lines.join("\n");
  }
  if (logs) {
    const tail =
      logs.length > MAX_LOG_CONTEXT
        ? "…(début tronqué)\n" + logs.slice(-MAX_LOG_CONTEXT)
        : logs;
    block += "\n\n--- Logs récents du client (les plus récents en bas) ---\n" + tail;
  }
  return block;
}

// Pull the assistant's visible text out of a content array.
function textFrom(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function toolFrom(content) {
  if (!Array.isArray(content)) return null;
  const block = content.find(
    (b) => b && b.type === "tool_use" && b.name === SUBMIT_TOOL.name
  );
  return block ? block.input || {} : null;
}

// Run one assistant turn over the prior transcript (an array of {role, content}
// text turns). Returns:
//   { reply, finalize } — finalize is the submit_ticket input when Claude chose
//   to finalize this turn, otherwise null. Returns null on disabled/error so the
//   route can fall back gracefully (mirrors github.js's swallow-and-log).
export async function runSupportTurn(messages, context = {}) {
  if (!anthropicEnabled()) return null;
  // Diagnostics ride in the system prompt (stable across a conversation's turns,
  // so the prompt cache still hits) — not in `messages`, which is the transcript
  // shown to the user.
  const system = SYSTEM + diagnosticContext(context);
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "x-api-key": apiKey(),
        "anthropic-version": API_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model(),
        max_tokens: MAX_TOKENS,
        system,
        tools: [SUBMIT_TOOL],
        messages,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[anthropic] turn failed: ${res.status} ${detail.slice(0, 300)}`);
      return null;
    }
    const data = await res.json();
    const finalize = toolFrom(data.content);
    let reply = textFrom(data.content);
    if (finalize && !reply) {
      reply =
        "Merci, j'ai tout ce qu'il faut. Je transmets votre ticket à l'équipe.";
    }
    return { reply, finalize };
  } catch (e) {
    console.error("[anthropic] turn error:", e.message);
    return null;
  }
}
