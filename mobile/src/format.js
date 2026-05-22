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
