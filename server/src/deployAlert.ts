// Alertes de la plateforme de déploiement des petites apps (dépôt Murgat-Ingenierie/deployer),
// envoyées par son serveur via POST /support/deploy. Comme pour le disque du serveur TSE, le texte
// est composé ici à partir de champs vérifiés ; seule exception, la raison exacte d'un échec
// (detail : texte brut d'une ligne, 400 caractères au plus, comme le titre d'une PR pour /notify).

// « arret » / « reprise » : la publication automatique elle-même ne tourne plus, puis repart ;
// le champ app est alors ignoré (la plateforme envoie « plateforme »).
export const DEPLOY_EVENTS = ["en-ligne", "echec", "relecture", "arret", "reprise"] as const;

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
  minutes?: number;
  appUrl?: string;
  repoUrl?: string;
  dashboardUrl?: string;
  detailUrl?: string;
  detail?: string;
  test?: boolean;
}) {
  const test = a.test ? "🧪 Test — " : "";
  let lignes: (string | undefined)[];
  switch (a.event) {
    case "en-ligne":
      lignes = [`${test}🚀 ${a.app} est en ligne${a.version ? ` (version ${a.version})` : ""}.`, a.appUrl];
      break;
    case "echec":
      lignes = [
        `${test}❌ Déploiement de ${a.app} en échec : ${DEPLOY_REASONS[a.reason ?? "autre"]}.`,
        a.detail && `Raison : ${a.detail}`,
        a.detailUrl && `Détail : ${a.detailUrl}`,
      ];
      break;
    case "relecture":
      lignes = [
        `${test}👀 ${a.app} attend la relecture d'un référent avant sa mise en ligne.`,
        a.detailUrl && `À relire : ${a.detailUrl}`,
      ];
      break;
    case "arret":
      lignes = [
        `${test}⛔ La publication automatique des apps est arrêtée${a.minutes ? ` depuis ${a.minutes} minutes` : ""} : ` +
          "plus aucune mise en ligne ni mise à jour n'aboutit.",
      ];
      break;
    case "reprise":
      lignes = [`${test}✅ La publication automatique des apps a repris.`];
      break;
  }
  lignes.push(a.repoUrl && `Code : ${a.repoUrl}`, a.dashboardUrl && `Tableau de bord : ${a.dashboardUrl}`);
  return lignes.filter(Boolean).join("\n");
}
