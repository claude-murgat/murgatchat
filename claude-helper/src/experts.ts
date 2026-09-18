// Un expert = un workspace : le cwd de l'agent, avec son CLAUDE.md (connaissance
// permanente), .claude/settings.json (permissions), bin/ (accès), mirror/ et
// notes/. La clé vient du chat (POST /turn {expert}) et se résout ici en chemin :
//   supervision → WORKSPACE (historique, défaut /home/murgat/claude-helper)
//   <clé>       → WORKSPACE_<CLÉ EN MAJUSCULES>   ex. WORKSPACE_MANAGEMENT
// Une clé sans workspace = 400 côté HTTP, jamais un repli silencieux sur un
// autre expert : chaque conversation doit tomber dans le bon cerveau.

export const DEFAULT_EXPERT = "supervision";

const KEY_RE = /^[a-z][a-z0-9_-]{0,30}$/;

export function workspaceFor(expert: string | undefined | null): string | null {
  const key = expert || DEFAULT_EXPERT;
  if (!KEY_RE.test(key)) return null;
  if (key === DEFAULT_EXPERT) return process.env.WORKSPACE || "/home/murgat/claude-helper";
  const value = process.env[`WORKSPACE_${key.toUpperCase().replace(/-/g, "_")}`];
  return value && value.trim() ? value.trim() : null;
}

// Les experts que ce service sait servir (pour /health et les logs de démarrage).
export function knownExperts(): string[] {
  const keys = new Set([DEFAULT_EXPERT]);
  for (const [name, value] of Object.entries(process.env)) {
    const m = /^WORKSPACE_([A-Z][A-Z0-9_]*)$/.exec(name);
    if (m && value && value.trim()) keys.add(m[1].toLowerCase());
  }
  return [...keys];
}
