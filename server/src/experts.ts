// Registre des experts Claude de la section CLAUDE. Un expert = un workspace
// distinct sur la VM claude-helper (CLAUDE.md, accès, permissions) et, côté
// chat, un canal kind="claude" par utilisateur ET par expert (Channel.expert).
// Le serveur ne connaît que la clé et les libellés ; le helper résout la clé en
// workspace (WORKSPACE_<CLÉ> dans son .env). CLAUDE_EXPERTS (clés séparées par
// des virgules) dit lesquels sont ouverts sur ce serveur — défaut : supervision
// seul, le comportement historique. Env lu paresseusement (les tests basculent
// la feature au cas par cas), comme dans claudeHelper.ts.

export interface ExpertDef {
  /** Clé stable : Channel.expert, corps de POST /claude/conversation, payload /turn. */
  key: string;
  /** Nom du canal (et libellé dans la barre latérale). */
  name: string;
  /** Sous-titre de l'en-tête de la conversation (= description du canal). */
  tagline: string;
  /** Libellé du bouton d'ouverture dans la barre latérale. */
  button: string;
}

export const EXPERTS: Record<string, ExpertDef> = {
  supervision: {
    key: "supervision",
    name: "Expert supervision",
    tagline: "Expert de l'application SUPERVISION",
    button: "Consulter l'expert supervision",
  },
  management: {
    key: "management",
    name: "Expert Murgat Management",
    tagline: "Expert de Murgat Management — refonte, stack de test (172.16.1.203)",
    button: "Consulter l'expert Murgat Management",
  },
};

export const DEFAULT_EXPERT = "supervision";

// Clés ouvertes sur ce serveur, dans l'ordre de CLAUDE_EXPERTS ; les clés
// inconnues sont ignorées (une faute de frappe ne doit pas ouvrir n'importe quoi).
export function enabledExpertKeys(): string[] {
  const raw = (process.env.CLAUDE_EXPERTS || "").trim();
  const keys = (raw || DEFAULT_EXPERT).split(",").map((k) => k.trim()).filter(Boolean);
  return [...new Set(keys)].filter((k) => Boolean(EXPERTS[k]));
}

export function enabledExperts(): ExpertDef[] {
  return enabledExpertKeys().map((k) => EXPERTS[k]);
}

// L'expert demandé s'il est ouvert ici, sinon null. Sans clé (clients antérieurs
// à la section multi-experts) : supervision.
export function getEnabledExpert(key: string | null | undefined): ExpertDef | null {
  const k = key || DEFAULT_EXPERT;
  return enabledExpertKeys().includes(k) ? EXPERTS[k] : null;
}
