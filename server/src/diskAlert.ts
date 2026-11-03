import fs from "node:fs";
import type { Server } from "socket.io";
import { UPLOAD_DIR } from "./storage.ts";
import { postPipelineMessage } from "./notify.ts";
import { notifyMembers } from "./socket.ts";

// Paliers d'occupation (en %) du disque qui porte les pièces jointes : chacun,
// une fois franchi, poste un avertissement dans le salon support-dev (admins).
const LEVELS = [90, 95];

// shortcut: palier déjà signalé gardé en mémoire, un redémarrage du serveur
// répète l'alerte du palier en cours ; le persister si cela devient gênant.
let warnedLevel = 0;

const gb = (bytes: number) => (bytes / 2 ** 30).toFixed(1).replace(".", ",");

// Lancée par startServer() à la même cadence que la purge des pièces jointes.
// Renvoie le palier atteint (0 sous le premier).
export async function checkDiskSpace(io?: Server) {
  const { blocks, bavail, bsize } = await fs.promises.statfs(UPLOAD_DIR);
  const usedPct = 100 * (1 - bavail / blocks);
  const level = Math.max(0, ...LEVELS.filter((l) => usedPct >= l));
  if (level > warnedLevel) {
    const text =
      `⚠️ Disque du serveur occupé à ${Math.floor(usedPct)} % : il reste ${gb(bavail * bsize)} Go ` +
      `sur ${gb(blocks * bsize)} Go. Administration → Stockage montre ce qui prend de la place.`;
    const { channelId, authorId, serialized } = await postPipelineMessage(text, io);
    if (io) {
      io.to(`channel:${channelId}`).emit("message:new", serialized);
      await notifyMembers(io, channelId, authorId, serialized);
    }
  }
  // Réarmé seulement 2 points sous le palier : pas d'alerte à chaque oscillation autour.
  if (level > warnedLevel || usedPct < warnedLevel - 2) warnedLevel = level;
  return level;
}

// Alerte d'une autre machine (le serveur TSE, par ops/alerte-disque.ps1, via
// POST /support/disk-alert). Le texte est composé ici et non par le script :
// Windows PowerShell 5.1 lit un .ps1 sans BOM en ANSI, ses accents et emoji
// arriveraient abîmés. Les paliers et leur réarmement vivent dans le script.
export function remoteDiskAlertText(a: {
  host: string;
  drive: string;
  free: number;
  total: number;
  test?: boolean;
}) {
  const usedPct = a.total > 0 ? Math.floor(100 * (1 - a.free / a.total)) : 0;
  const head = a.test ? "🧪 Test de l'alerte disque —" : "⚠️";
  return (
    `${head} Disque ${a.drive} du serveur ${a.host} occupé à ${usedPct} % : ` +
    `il reste ${gb(a.free)} Go sur ${gb(a.total)} Go.`
  );
}
