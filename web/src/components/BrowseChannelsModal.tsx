import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { Channel, User } from "../types.ts";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss.ts";
import { canDeleteSalon, isSalon } from "../channelRules.ts";

interface BrowseChannelsModalProps {
  currentUser: User;
  /** Conversations du lecteur : ses salons publics s'affichent avec « Ouvrir ». */
  channels: Channel[];
  onClose: () => void;
  onOpen: (channel: Channel) => void;
  onJoined: (channel: Channel) => void;
  /** Un admin (du salon ou du chat) a supprimé un salon public depuis la liste. */
  onDeleted: (channelId: string) => void;
  onCreate: () => void;
}

const norm = (s: string | null | undefined) =>
  (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

// « Parcourir les salons » : les salons publics, qu'on en soit membre ou non.
// Avant, un salon public ne se trouvait qu'en tapant son nom, d'où des doublons.
// Les salons privés n'y figurent jamais : ils n'existent que pour leurs membres.
export default function BrowseChannelsModal({
  currentUser,
  channels,
  onClose,
  onOpen,
  onJoined,
  onDeleted,
  onCreate,
}: BrowseChannelsModalProps) {
  const overlayDismiss = useOverlayDismiss(onClose);
  const [q, setQ] = useState("");
  const [others, setOthers] = useState<Channel[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .publicChannels(q.trim())
        .then((res) => {
          if (!cancelled) setOthers(res.channels || []);
        })
        .catch(() => {
          /* transitoire : on garde la dernière liste */
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  const ql = norm(q.trim());
  const mine = channels.filter(
    (c) => isSalon(c) && !c.isPrivate && (!ql || norm(c.name).includes(ql))
  );
  const rows = [
    ...mine.map((c) => ({ channel: c, member: true })),
    ...others
      .filter((c) => !channels.some((m) => m.id === c.id))
      .map((c) => ({ channel: c, member: false })),
  ].sort((a, b) => (a.channel.name || "").localeCompare(b.channel.name || "", "fr"));

  async function join(c: Channel) {
    setBusyId(c.id);
    try {
      const res = await api.joinChannel(c.id);
      onJoined(res.channel);
    } catch (e) {
      alert((e as Error).message);
      setBusyId(null);
    }
  }

  async function destroy(c: Channel) {
    if (confirmDelete !== c.id) return setConfirmDelete(c.id);
    setBusyId(c.id);
    try {
      await api.deleteChannel(c.id);
      setOthers((prev) => prev.filter((o) => o.id !== c.id));
      onDeleted(c.id);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusyId(null);
      setConfirmDelete(null);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 grid place-items-stretch sm:place-items-center z-50 p-0 sm:p-4"
      {...overlayDismiss}
    >
      <div
        role="dialog"
        aria-label="Parcourir les salons"
        onClick={(e) => e.stopPropagation()}
        className="bg-white text-slate-900 sm:rounded-xl shadow-2xl w-full h-dvh sm:h-auto sm:max-w-lg sm:max-h-[90vh] flex flex-col"
      >
        <div className="p-5 border-b border-slate-200 flex items-center justify-between gap-3">
          <h2 className="text-xl font-bold">Parcourir les salons</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-800 w-8 h-8"
            aria-label="Fermer"
          >
            ✕
          </button>
        </div>
        <div className="p-4">
          <input
            autoFocus
            className="w-full border rounded-md px-3 py-2"
            placeholder="Rechercher un salon"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <p className="text-xs text-slate-500 mt-1">
            Les salons privés n'apparaissent qu'à leurs membres.
          </p>
        </div>
        <div className="px-2 pb-2 overflow-y-auto flex-1 min-h-0">
          {rows.map(({ channel: c, member }) => (
            <div
              key={c.id}
              className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-slate-50"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate"># {c.name}</div>
                <div className="text-xs text-slate-500 truncate">
                  {member ? "Membre · " : ""}
                  {c.members.length} membre{c.members.length > 1 ? "s" : ""}
                  {c.description ? ` · ${c.description}` : ""}
                </div>
              </div>
              {/* Admin du salon (il en est membre) ou admin du chat, membre ou non. */}
              {canDeleteSalon(c, currentUser) && (
                <button
                  type="button"
                  onClick={() => void destroy(c)}
                  disabled={busyId === c.id}
                  className={`text-xs px-2 py-1 rounded-md disabled:opacity-50 ${
                    confirmDelete === c.id
                      ? "bg-red-600 text-white"
                      : "text-red-600 hover:bg-red-50"
                  }`}
                >
                  {confirmDelete === c.id ? "Confirmer" : "Supprimer"}
                </button>
              )}
              {member ? (
                <button
                  type="button"
                  onClick={() => onOpen(c)}
                  className="text-sm px-3 py-1 rounded-md border border-slate-300 hover:bg-slate-100"
                >
                  Ouvrir
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void join(c)}
                  disabled={busyId === c.id}
                  className="text-sm px-3 py-1 rounded-md bg-aubergine-700 text-white hover:bg-aubergine-800 disabled:opacity-50"
                >
                  Rejoindre
                </button>
              )}
            </div>
          ))}
          {rows.length === 0 && (
            <div className="px-3 py-3 text-sm text-slate-500">Aucun salon public trouvé.</div>
          )}
        </div>
        <div className="p-4 border-t border-slate-200 flex justify-end">
          <button
            type="button"
            onClick={onCreate}
            className="px-4 py-2 rounded-md bg-aubergine-700 text-white font-medium hover:bg-aubergine-800"
          >
            Créer un salon
          </button>
        </div>
      </div>
    </div>
  );
}
