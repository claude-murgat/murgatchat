import { useEffect, useState } from "react";
import { api } from "../api.ts";
import Avatar from "./Avatar.tsx";
import type { Channel, User } from "../types.ts";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss.ts";
import { defaultSalonName, isSalon, sameMembers, salonLabel } from "../channelRules.ts";

interface NewDmModalProps {
  onClose: () => void;
  /** Reçoit la conversation directe ouverte (ou rouverte) par le serveur. */
  onOpened: (channel: Channel) => void;
  /** Reçoit le salon privé créé (plusieurs personnes choisies). */
  onCreated: (channel: Channel) => void;
  /** Ouvre une conversation existante (salon privé déjà formé avec ces personnes). */
  onSelectChannel: (channel: Channel) => void;
  currentUser: User;
  /** Conversations du lecteur : pour proposer un salon privé déjà formé. */
  channels: Channel[];
}

// « Nouveau message » : une personne = conversation directe ; plusieurs = un
// salon privé avec elles (1.6.0 : un groupe est un salon privé, géré par ses
// membres), nommé d'après les participants tant qu'on ne le renomme pas.
export default function NewDmModal({
  onClose,
  onOpened,
  onCreated,
  onSelectChannel,
  currentUser,
  channels,
}: NewDmModalProps) {
  const overlayDismiss = useOverlayDismiss(onClose);
  const currentUserId = currentUser.id;
  const [users, setUsers] = useState<User[]>([]);
  // Les personnes choisies, gardées entières : la liste affichée change avec la
  // recherche, la sélection (et le nom proposé) ne doit pas en dépendre.
  const [selected, setSelected] = useState<Map<string, User>>(() => new Map());
  const [q, setQ] = useState("");
  const [salonName, setSalonName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // We DO keep the current user in the list now: ticking only yourself opens
    // (or reopens) the "Mes notes" self-DM. The list reorders the caller on top.
    api.listUsers(q).then((res) => {
      if (cancelled) return;
      const sorted = [...(res.users as User[])].sort((a, b) => {
        if (a.id === currentUserId) return -1;
        if (b.id === currentUserId) return 1;
        return 0;
      });
      setUsers(sorted);
    });
    return () => {
      cancelled = true;
    };
  }, [q, currentUserId]);

  // A self-DM is a one-member channel — picking yourself is mutually exclusive
  // with picking anyone else. The opposite checkboxes are *disabled* (instead
  // of silently cleared) so the constraint is visible in the UI.
  const selfPicked = selected.has(currentUserId);
  const others = [...selected.values()].filter((u) => u.id !== currentUserId);
  const othersPicked = others.length > 0;
  const isGroup = others.length >= 2;
  const proposedName = defaultSalonName([
    currentUser.displayName,
    ...others.map((u) => u.displayName),
  ]);
  const name = salonName ?? proposedName;
  // Un salon privé réunit déjà exactement ces personnes : on le propose plutôt
  // que d'en créer un double (c'est ce qui encombrait les listes).
  const existing = isGroup
    ? channels.find(
        (c) =>
          isSalon(c) &&
          c.isPrivate &&
          !c.isDefault &&
          sameMembers(c, [currentUserId, ...others.map((u) => u.id)])
      )
    : undefined;

  function toggle(u: User) {
    const isSelf = u.id === currentUserId;
    setSelected((prev) => {
      // Ticking yourself empties the rest (single-member self-DM).
      if (isSelf) return prev.has(u.id) ? new Map() : new Map([[u.id, u]]);
      const next = new Map(prev);
      next.delete(currentUserId); // defensive — disabled above prevents reaching this
      if (next.has(u.id)) next.delete(u.id);
      else next.set(u.id, u);
      return next;
    });
  }

  async function start() {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      if (isGroup) {
        const res = await api.createChannel({
          name: name.trim() || proposedName,
          isPrivate: true,
          memberIds: others.map((u) => u.id),
        });
        onCreated(res.channel);
      } else {
        const res = await api.openDm([...selected.keys()]);
        onOpened(res.channel);
      }
    } catch (err) {
      // `request()` (api.ts) ne rejette qu'avec des Error : simple vue typée.
      alert((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 grid place-items-stretch sm:place-items-center z-50 p-0 sm:p-4"
      {...overlayDismiss}
    >
      <div
        role="dialog"
        aria-label="Nouveau message"
        className="bg-white text-slate-900 sm:rounded-xl shadow-2xl w-full h-dvh sm:h-auto sm:max-w-md sm:max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-xl font-bold">Nouveau message</h2>
          <button
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
            placeholder="Rechercher une ou plusieurs personnes..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <p className="text-xs text-slate-500 mt-1">
            Une personne pour un message direct, plusieurs pour créer un salon privé avec elles.
          </p>
        </div>
        <div className="px-2 pb-2 overflow-y-auto flex-1 min-h-0">
          {users.map((u) => {
            const isMe = u.id === currentUserId;
            const disabled = isMe ? othersPicked : selfPicked;
            return (
              <label
                key={u.id}
                title={
                  disabled
                    ? isMe
                      ? "Décochez les autres pour ouvrir vos notes"
                      : "Décochez « Mes notes » pour démarrer un DM"
                    : undefined
                }
                className={`flex items-center gap-3 px-3 py-2 rounded-md ${
                  disabled
                    ? "opacity-50 cursor-not-allowed"
                    : "hover:bg-slate-100 cursor-pointer"
                }`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(u.id)}
                  disabled={disabled}
                  onChange={() => toggle(u)}
                />
                <Avatar user={u} size={32} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {isMe ? "📝 Mes notes" : u.displayName}
                    {isMe && (
                      <span className="ml-1 text-xs text-slate-500 font-normal">
                        (notes pour vous-même)
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 truncate">@{u.username}</div>
                </div>
              </label>
            );
          })}
          {users.length === 0 && (
            <div className="px-3 py-3 text-sm text-slate-500">Aucun utilisateur</div>
          )}
        </div>
        <div className="border-t border-slate-200">
          {isGroup && (
            <div className="px-4 pt-3 space-y-2">
              <label className="block">
                <span className="text-sm font-semibold">Nom du salon privé</span>
                <input
                  className="mt-1 w-full border rounded-md px-3 py-2"
                  value={name}
                  maxLength={80}
                  onChange={(e) => setSalonName(e.target.value)}
                />
              </label>
              {existing && (
                <div className="text-sm bg-amber-50 border border-amber-200 rounded-md px-3 py-2 flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    Vous avez déjà <strong className="break-words">{salonLabel(existing)}</strong>{" "}
                    avec ces personnes.
                  </span>
                  <button
                    type="button"
                    onClick={() => onSelectChannel(existing)}
                    className="shrink-0 px-2 py-1 rounded-md bg-white border border-amber-300 hover:bg-amber-100 font-medium"
                  >
                    Ouvrir
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="p-4 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md border border-slate-300"
            >
              Annuler
            </button>
            <button
              onClick={start}
              disabled={busy || selected.size === 0 || (isGroup && !name.trim())}
              className="px-3 py-1.5 rounded-md bg-aubergine-700 text-white font-medium hover:bg-aubergine-800 disabled:opacity-50"
            >
              {isGroup
                ? existing
                  ? "Créer un autre salon"
                  : `Créer le salon privé (${others.length + 1})`
                : "Démarrer"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
