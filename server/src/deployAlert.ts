// Alertes de la plateforme de déploiement des petites apps (dépôt Murgat-Ingenierie/deployer),
// envoyées par son serveur via POST /support/deploy. Comme pour le disque du serveur TSE, le texte
// est composé ici à partir de champs vérifiés, jamais d'un texte libre.

export const DEPLOY_EVENTS = ["en-ligne", "echec", "relecture"] as const;

export const DEPLOY_REASONS = {
  secret: "un secret (clé, mot de passe) est écrit dans le code",
  verification: "l'app ne passe pas la vérification",
  depot: "dépôt introuvable ou inaccessible",
  construction: "le serveur n'a pas pu construire l'app",
  demarrage: "l'app ne démarre pas sur le serveur",
  refus: "la fiche de l'app est refusée",
  autre: "voir le détail",
} as const;

export type DeployReason = keyof typeof DEPLOY_REASONS;

export function deployAlertText(a: {
  event: (typeof DEPLOY_EVENTS)[number];
  app: string;
  version?: string;
  reason?: DeployReason;
  appUrl?: string;
  repoUrl?: string;
  dashboardUrl?: string;
  detailUrl?: string;
  test?: boolean;
}) {
  const test = a.test ? "🧪 Test — " : "";
  const lignes: (string | undefined)[] =
    a.event === "en-ligne"
      ? [`${test}🚀 ${a.app} est en ligne${a.version ? ` (version ${a.version})` : ""}.`, a.appUrl]
      : a.event === "echec"
        ? [
            `${test}❌ Déploiement de ${a.app} en échec : ${DEPLOY_REASONS[a.reason ?? "autre"]}.`,
            a.detailUrl && `Détail : ${a.detailUrl}`,
          ]
        : [
            `${test}👀 ${a.app} attend la relecture d'un référent avant sa mise en ligne.`,
            a.detailUrl && `À relire : ${a.detailUrl}`,
          ];
  lignes.push(a.repoUrl && `Code : ${a.repoUrl}`, a.dashboardUrl && `Tableau de bord : ${a.dashboardUrl}`);
  return lignes.filter(Boolean).join("\n");
}
