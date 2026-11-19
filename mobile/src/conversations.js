// Rangement des conversations de l'accueil (onglets Récents / Salons / Directs).
// Le miroir des règles du web (web/src/channelRules.ts, barre latérale de
// web/src/components/Sidebar.tsx) : salons par ordre alphabétique, messages
// directs par activité récente, « Mes notes » épinglée, conversation directe
// masquée absente jusqu'au prochain message. Fonctions pures, sans React.

const byName = (a, b) =>
  (a.name || a.displayName || "").localeCompare(b.name || b.displayName || "", "fr", {
    sensitivity: "base",
  });

/** Horodatage (ms) du dernier message, 0 sans message. */
export function lastActivity(c) {
  const t = c?.lastMessage?.createdAt ? new Date(c.lastMessage.createdAt).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
}

/** Le plus récent d'abord ; à égalité (aucun message), par nom. */
export function byActivity(a, b) {
  return lastActivity(b) - lastActivity(a) || byName(a, b);
}

/** Salon (public ou privé) : ni conversation directe, ni conversation d'expert Claude. */
export function isSalon(c) {
  return !c.isDirect && c.kind !== "claude";
}

/** Conversation privée avec un expert Claude (section à part, comme sur le web). */
export function isExpert(c) {
  return !c.isDirect && c.kind === "claude";
}

/** « Mes notes » : la conversation directe dont le lecteur est le seul membre. */
export function isSelfDm(c, user) {
  return !!c.isDirect && c.members?.length === 1 && c.members[0]?.id === user?.id;
}

/** Conversation directe masquée par le lecteur (sur le web), sans message arrivé depuis. */
export function isHiddenDm(c) {
  if (!c.isDirect || !c.hiddenAt) return false;
  if (!c.lastMessage?.createdAt) return true;
  return lastActivity(c) <= new Date(c.hiddenAt).getTime();
}

/**
 * Le contenu des trois onglets, et le nombre de conversations non lues de chacun
 * (les pastilles de la barre d'onglets).
 *   - recentUnread / recentRead : toutes les conversations qui ont un message, non
 *     lues d'abord, puis par activité ;
 *   - salons (alphabétique) et experts (par activité) ;
 *   - selfDm (« Mes notes », ou null) et dms (par activité).
 */
export function homeLists(channels, user) {
  const visible = (channels || []).filter((c) => !isHiddenDm(c));
  const recent = visible.filter((c) => lastActivity(c) > 0).sort(byActivity);
  const salons = visible.filter(isSalon).sort(byName);
  const experts = visible.filter(isExpert).sort(byActivity);
  const selfDm = visible.find((c) => isSelfDm(c, user)) || null;
  const dms = visible.filter((c) => c.isDirect && !isSelfDm(c, user)).sort(byActivity);
  const unreadCount = (list) => list.filter((c) => c.unread).length;
  return {
    recentUnread: recent.filter((c) => c.unread),
    recentRead: recent.filter((c) => !c.unread),
    salons,
    experts,
    selfDm,
    dms,
    counts: {
      recent: unreadCount(visible),
      salons: unreadCount(salons) + unreadCount(experts),
      dms: unreadCount(dms) + (selfDm?.unread ? 1 : 0),
    },
  };
}

/** Le texte d'un message sur une ligne : sauts de ligne et balises Markdown retirés. */
export function oneLine(body) {
  if (!body) return "";
  return String(body)
    .slice(0, 400)
    .replace(/```[^\n]*\n?/g, " ") // ouvertures / fermetures de blocs de code
    .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "") // titres, citations, listes
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [texte](lien) → texte
    .replace(/\s+/g, " ")
    .trim();
}

function firstName(displayName) {
  return (displayName || "").trim().split(/\s+/)[0] || "Quelqu'un";
}

/**
 * L'extrait du dernier message, préfixé de son auteur là où il n'est pas évident :
 * « Vous : … » pour ses propres messages, « Prénom : … » dans un salon ou un
 * groupe ; rien dans une conversation à deux ni dans « Mes notes ».
 */
export function previewText(c, user) {
  const m = c?.lastMessage;
  if (!m) return "";
  const body = oneLine(m.body) || "(pièce jointe)";
  if (isSelfDm(c, user)) return body;
  if (m.authorId && m.authorId === user?.id) return `Vous : ${body}`;
  if (c.isDirect && (c.members?.length || 0) <= 2) return body;
  const author = c.members?.find((u) => u.id === m.authorId);
  return author ? `${firstName(author.displayName)} : ${body}` : body;
}
