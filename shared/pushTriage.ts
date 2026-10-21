// Que faire d'un Web Push de message à son arrivée dans le service worker
// (web/src/sw.ts) ? Logique pure, partagée pour être testée côté serveur.
//
// Le push arrive parfois des heures après son envoi (Android le retient en Doze
// jusqu'au déverrouillage), pour un message lu depuis sur un autre appareil. Le
// service worker demande donc au serveur l'état de lecture du message entrant et
// des notifications déjà affichées, puis :
//   - ferme les notifications de messages lus depuis ;
//   - n'affiche pas (et ne fait pas vibrer) un message déjà lu.
//
// Contrainte des navigateurs : un push DOIT laisser une notification visible.
// Chrome en affiche sinon une générique (« Ce site a été mis à jour en
// arrière-plan ») ; Safari/iOS révoque l'abonnement après quelques pushs
// silencieux. D'où les règles quand le message entrant est déjà lu :
//   - s'il reste une notification non lue, on n'affiche rien ;
//   - sinon on garde visible la plus récente des notifications lues déjà
//     affichées (aucune nouvelle vibration) ;
//   - sinon, rien n'étant affiché, on montre le message SANS son ni vibration ;
//   - `mustShow` (Safari/iOS) : on affiche toujours, en silence.

/** État d'une notification déjà affichée. `read: null` = inconnu (gardée). */
export type DisplayedNotification = { read: boolean | null; receivedAt: number };

export type PushTriage = {
  /** "normal" : comme avant ; "silent" : sans son ni vibration ; "none" : rien. */
  show: "normal" | "silent" | "none";
  /** Index (dans `displayed`) des notifications à fermer. */
  close: number[];
};

/**
 * @param incomingRead état de lecture du message entrant (null = inconnu : on
 *   affiche normalement, comme sans vérification).
 * @param displayed notifications déjà affichées par l'application.
 * @param mustShow le navigateur exige une notification par push (Safari/iOS).
 */
export function triagePush(
  incomingRead: boolean | null,
  displayed: DisplayedNotification[],
  mustShow = false
): PushTriage {
  const readIdx = displayed.flatMap((d, i) => (d.read === true ? [i] : []));
  if (incomingRead !== true) return { show: "normal", close: readIdx };
  if (mustShow) return { show: "silent", close: readIdx };
  if (displayed.some((d) => d.read !== true)) return { show: "none", close: readIdx };
  if (readIdx.length > 0) {
    const keep = readIdx.reduce((a, b) =>
      displayed[b].receivedAt > displayed[a].receivedAt ? b : a
    );
    return { show: "none", close: readIdx.filter((i) => i !== keep) };
  }
  return { show: "silent", close: [] };
}
