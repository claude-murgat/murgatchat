// Un tour d'analyse = une invocation de l'Agent SDK dans le workspace
// /home/murgat/claude-helper (CLAUDE.md = connaissance permanente de l'expert,
// .claude/settings.json = permissions). La continuité d'une conversation
// MurgaChat repose sur `resume` : on garde l'id de session Claude par canal
// dans state/sessions.json, l'historique vit chez Claude Code (~/.claude).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const WORKSPACE = process.env.WORKSPACE || "/home/murgat/claude-helper";
const STATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "state");
const SESSIONS_FILE = join(STATE_DIR, "sessions.json");
const TURN_TIMEOUT_MS = 15 * 60_000;
const MAX_REPLY = 20_000; // même plafond que le zod du callback côté MurgaChat

function loadSessions(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveSessions(map: Record<string, string>) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SESSIONS_FILE, JSON.stringify(map, null, 2));
}

// Libellé de progression dérivé d'un message assistant intermédiaire (= suivi
// d'un appel d'outil). On préfère la phrase que le modèle écrit avant d'agir
// (« je regarde les logs de php_supervision »), à défaut un statut générique
// tiré de l'outil. Un message assistant SANS tool_use est la réponse finale :
// on ne l'affiche pas en progression (il arrivera comme message du bot).
function progressLabel(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const tool = content.find((b) => b && b.type === "tool_use");
  if (!tool) return null; // réponse finale, pas une étape

  const text = content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text.trim())
    .join(" ")
    .split("\n")[0]
    .trim();
  if (text) return text.length > 160 ? text.slice(0, 157) + "…" : text;

  // Pas de phrase : statut générique selon l'outil.
  const cmd = String(tool.input?.command ?? "").toLowerCase();
  if (tool.name === "Bash") {
    if (cmd.includes("docker logs")) return "Lecture des logs de la supervision…";
    if (/docker (ps|stats|inspect|top)/.test(cmd)) return "Inspection des conteneurs…";
    if (cmd.includes("bin/db") || cmd.includes("mariadb")) return "Interrogation de la base…";
    if (cmd.includes("sync-mirror")) return "Mise à jour du miroir du code…";
    if (cmd.startsWith("ssh")) return "Connexion à la supervision…";
    return "Exécution d'une commande…";
  }
  if (["Read", "Grep", "Glob"].includes(tool.name)) return "Lecture du code…";
  if (["Write", "Edit"].includes(tool.name)) return "Prise de notes…";
  return "Analyse en cours…";
}

export async function runTurn(
  key: string,
  prompt: string,
  onProgress?: (text: string) => void
): Promise<{ ok: boolean; reply?: string; error?: string }> {
  const sessions = loadSessions();
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TURN_TIMEOUT_MS);

  try {
    const q = query({
      prompt,
      options: {
        model: "claude-opus-5",
        cwd: WORKSPACE,
        resume: sessions[key],
        // Charger UNIQUEMENT les réglages du workspace : CLAUDE.md +
        // .claude/settings.json (permissions). Pas de réglages utilisateur.
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        // Auto-approuvés ; le périmètre fin (notes/ en écriture, 3 préfixes
        // Bash, .env interdits en lecture) vit dans .claude/settings.json —
        // c'est lui qui fait autorité, deny d'abord.
        allowedTools: ["Read", "Grep", "Glob", "Write", "Edit", "TodoWrite", "Bash"],
        disallowedTools: ["WebSearch", "WebFetch", "NotebookEdit"],
        // Tout ce qui n'est pas explicitement permis est refusé net (pas de
        // prompt interactif — personne pour y répondre).
        permissionMode: "dontAsk",
        maxTurns: 100,
        abortController: ac,
      },
    });

    let reply = "";
    let failed: string | null = null;
    let lastProgress = "";
    for await (const msg of q) {
      // Formes vérifiées contre les types du SDK à l'installation ; on reste
      // structurel pour tolérer les champs additionnels d'une version à l'autre.
      const m = msg as {
        type: string;
        subtype?: string;
        session_id?: string;
        result?: string;
        total_cost_usd?: number;
        is_error?: boolean;
        message?: { content?: unknown };
        content?: unknown;
      };
      if (m.session_id && sessions[key] !== m.session_id) {
        sessions[key] = m.session_id;
        saveSessions(sessions);
      }
      if (onProgress && m.type === "assistant") {
        const label = progressLabel(m.message?.content ?? m.content);
        if (label && label !== lastProgress) {
          lastProgress = label;
          try {
            onProgress(label);
          } catch {
            /* la progression est du confort : ne jamais casser le tour */
          }
        }
      }
      if (m.type === "result") {
        if (m.is_error || (m.subtype && m.subtype !== "success")) {
          failed = m.subtype || "error";
        } else {
          reply = m.result || "";
        }
        console.log(
          `[helper] tour ${key}: ${m.subtype || "success"} en ${Math.round(
            (Date.now() - started) / 1000
          )}s, coût $${(m.total_cost_usd ?? 0).toFixed(4)}`
        );
      }
    }

    if (failed) return { ok: false, error: failed };
    if (!reply.trim()) return { ok: false, error: "empty_reply" };
    if (reply.length > MAX_REPLY) {
      reply = reply.slice(0, MAX_REPLY - 60) + "\n\n*…réponse tronquée (limite du chat).*";
    }
    return { ok: true, reply };
  } catch (e) {
    const aborted = ac.signal.aborted;
    console.error(`[helper] tour ${key} interrompu:`, (e as Error).message);
    return { ok: false, error: aborted ? "timeout_15min" : "sdk_error" };
  } finally {
    clearTimeout(timer);
  }
}
