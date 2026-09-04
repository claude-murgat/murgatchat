// Relais du chat de support in-app de MurgaChat (bouton « Signaler un bug »).
//
// Pourquoi ici : l'abonnement Claude n'est utilisable qu'à travers le harnais
// Claude Code (SDK). L'API Messages brute avec un jeton d'abonnement est
// throttlée par politique (429 « nu », sans en-têtes de quota) — vérifié le
// 2026-09-04 pendant qu'un tour SDK réussissait au même instant. Le serveur de
// chat nous confie donc chaque tour de triage ; on l'exécute via le SDK, avec
// l'outil `submit_ticket` fourni en MCP in-process, et on renvoie le résultat.
//
// Sans état : le serveur envoie tout le transcript à chaque tour (comme il le
// faisait avec l'API), on l'aplatit dans le prompt. Les conversations de
// support sont courtes (24 tours max) — inutile de gérer des sessions ici.
// Workspace VIDE et `settingSources: []` : ce tour ne doit voir ni le CLAUDE.md
// de l'expert supervision, ni ses permissions, ni aucun outil de fichier.

import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const SUPPORT_WORKSPACE = process.env.SUPPORT_WORKSPACE || "/home/murgat/claude-support";
const TURN_TIMEOUT_MS = 90_000;

export type SupportMessage = { role: "user" | "assistant"; content: string };
export type SupportTurnResult = {
  reply: string;
  finalize: Record<string, unknown> | null;
};

// Aplatit le transcript en un seul prompt : historique lisible + dernier message.
// Exporté pour le test.
export function flattenTranscript(messages: SupportMessage[]): string {
  if (messages.length <= 1) return messages[0]?.content ?? "";
  const prior = messages.slice(0, -1);
  const last = messages[messages.length - 1];
  const lines = prior.map(
    (m) => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`
  );
  return (
    "[Historique de la conversation]\n" +
    lines.join("\n") +
    "\n[Fin de l'historique]\n\n" +
    "Nouveau message de l'utilisateur :\n" +
    last.content
  );
}

export async function runSupportTurn(
  system: string,
  messages: SupportMessage[]
): Promise<SupportTurnResult> {
  let finalize: Record<string, unknown> | null = null;

  // Même contrat que SUBMIT_TOOL dans server/src/anthropic.ts.
  const support = createSdkMcpServer({
    name: "support",
    tools: [
      tool(
        "submit_ticket",
        "Crée le ticket de support une fois la demande suffisamment claire (titre + description structurée).",
        {
          title: z.string(),
          body: z.string(),
          severity: z.enum(["faible", "moyenne", "élevée"]).optional(),
          domain: z.enum(["server", "web", "mobile", "desktop"]).optional(),
        },
        async (input) => {
          finalize = input as Record<string, unknown>;
          return { content: [{ type: "text", text: "Ticket enregistré." }] };
        }
      ),
    ],
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TURN_TIMEOUT_MS);
  try {
    const q = query({
      prompt: flattenTranscript(messages),
      options: {
        model: process.env.SUPPORT_MODEL || "claude-opus-4-8",
        cwd: SUPPORT_WORKSPACE,
        // Rien du workspace ni de l'utilisateur : le prompt système ci-dessous
        // est TOUT ce que le modèle sait, comme avec l'appel API d'origine.
        settingSources: [],
        systemPrompt: system,
        mcpServers: { support },
        allowedTools: ["mcp__support__submit_ticket"],
        disallowedTools: [
          "Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep",
          "WebSearch", "WebFetch", "NotebookEdit", "TodoWrite", "Task", "Agent",
        ],
        permissionMode: "dontAsk",
        maxTurns: 4, // une question OU un appel d'outil + le mot de la fin
        abortController: ac,
      },
    });

    let reply = "";
    for await (const msg of q) {
      const m = msg as { type: string; subtype?: string; result?: string; is_error?: boolean };
      if (m.type === "result") {
        if (m.is_error || (m.subtype && m.subtype !== "success")) {
          throw new Error(`result ${m.subtype || "error"}`);
        }
        reply = m.result || "";
      }
    }
    if (finalize && !reply.trim()) {
      reply = "Merci, j'ai tout ce qu'il faut. Je transmets votre ticket à l'équipe.";
    }
    return { reply, finalize };
  } finally {
    clearTimeout(timer);
  }
}
