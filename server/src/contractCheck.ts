// @ts-check
// Vérif non-bloquante d'un contrat de données à une frontière serveur : safeParse,
// journalise un écart compact via console.warn (capté par les logs serveur), et
// renvoie toujours `data` telle quelle — un décalage de schéma ne doit jamais casser
// le serveur. Pendant côté serveur de web/src/api.js#checkContract ; les schémas
// vivent dans le mini-package partagé (../../shared/contracts.ts).
/**
 * @template T
 * @param {import("zod").ZodType<T>} schema Schéma partagé (shared/contracts.ts).
 * @param {unknown} data Charge utile à contrôler.
 * @param {string} label Libellé de la frontière, pour le log.
 * @returns {unknown} `data`, inchangée (vérif non bloquante).
 */
export function checkContract(schema, data, label) {
  const res = schema.safeParse(data);
  if (!res.success) {
    const issues = res.error.issues
      .slice(0, 4)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join(" | ");
    console.warn(`[contract] ${label} — ${res.error.issues.length} écart(s): ${issues}`);
  }
  return data;
}
