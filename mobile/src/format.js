export function formatTime(d) {
  return new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function dayLabel(d) {
  const date = new Date(d);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const same = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (same(date, today)) return "Aujourd'hui";
  if (same(date, yesterday)) return "Hier";
  return date.toLocaleDateString();
}

const WEEKDAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const pad2 = (n) => String(n).padStart(2, "0");

// Moment du dernier message d'une conversation, en tête de ligne de l'accueil :
// l'heure aujourd'hui, « Hier », le jour de la semaine jusqu'à 6 jours, puis la
// date (jj/mm, avec l'année si ce n'est pas l'année en cours).
export function shortWhen(d, now = new Date()) {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86400000);
  if (days <= 0) return formatTime(date);
  if (days === 1) return "Hier";
  if (days < 7) return WEEKDAYS[date.getDay()];
  const dm = `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}`;
  return date.getFullYear() === now.getFullYear()
    ? dm
    : `${dm}/${String(date.getFullYear()).slice(-2)}`;
}

export function reactionLabel(users) {
  const names = (users || []).map((u) => u.displayName || "Quelqu'un");
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} a réagi`;
  if (names.length === 2) return `${names[0]} et ${names[1]} ont réagi`;
  const others = names.length - 2;
  return `${names[0]}, ${names[1]} et ${others} autre${others > 1 ? "s" : ""} ont réagi`;
}

export function typingLabel(userIds, channel, currentUser) {
  const names = (userIds || [])
    .filter((id) => id !== currentUser?.id)
    .map(
      (id) => channel?.members?.find((m) => m.id === id)?.displayName || "Quelqu'un"
    );
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} est en train d'écrire…`;
  if (names.length === 2) return `${names[0]} et ${names[1]} écrivent…`;
  return "Plusieurs personnes écrivent…";
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}
