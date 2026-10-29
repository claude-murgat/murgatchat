import { useState } from "react";
import { api } from "../api.ts";
import Avatar from "./Avatar.tsx";
import type { Channel, User } from "../types.ts";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss.ts";
import {
  canChangeVisibility,
  canDeleteSalon,
  canEditSalon,
  canManageMembers,
  salonLabel,
} from "../channelRules.ts";

export type DetailsTab = "about" | "members";

interface ChannelDetailsModalProps {
  /** Le salon tel que la liste le connaît : membres et nom suivent le temps réel. */
  channel: Channel;
  currentUser: User;
  initialTab?: DetailsTab;
  onClose: () => void;
  onSaved: (channel: Channel) => void;
  onLeft: (channelId: string) => void;
  onDeleted: (channelId: string) => void;
  onMembersChanged: (channelId: string, members: User[]) => void;
  /** Ouvre la fenêtre d'ajout de personnes (la fenêtre des détails se ferme). */
  onAddMembers: () => void;
}

// Le panneau « Détails » d'un salon, ouvert en cliquant sur son nom : tout ce
// qu'un membre peut faire au même endroit (1.6.0) — renommer et décrire,
// voir/ajouter/retirer les membres, quitter ; supprimer et changer la
// visibilité restent aux admins. Le serveur revérifie chaque action.
export default function ChannelDetailsModal({
  channel,
  currentUser,
  initialTab = "about",
  onClose,
  onSaved,
  onLeft,
  onDeleted,
  onMembersChanged,
  onAddMembers,
}: ChannelDetailsModalProps) {
  const overlayDismiss = useOverlayDismiss(onClose);
  const [tab, setTab] = useState<DetailsTab>(initialTab);
  const [name, setName] = useState(channel.name || "");
  const [description, setDescription] = useState(channel.description || "");
  const [isPrivate, setIsPrivate] = useState(!!channel.isPrivate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"leave" | "delete" | null>(null);

  const editable = canEditSalon(channel, currentUser);
  const visibilityEditable = canChangeVisibility(channel, currentUser);
  const membersEditable = canManageMembers(channel);
  const deletable = canDeleteSalon(channel, currentUser);
  const dirty =
    name.trim() !== (channel.name || "") ||
    description.trim() !== (channel.description || "") ||
    isPrivate !== !!channel.isPrivate;
  const creator = channel.members.find((m) => m.id === channel.createdById);
  const lastOne = channel.members.length <= 1;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      // `request()` (api.ts) ne rejette qu'avec des Error : simple vue typée.
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      const res = await api.updateChannel(channel.id, {
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
        ...(visibilityEditable ? { isPrivate } : {}),
      });
      onSaved(res.channel);
    });

  const remove = (u: User) =>
    run(async () => {
      await api.removeMember(channel.id, u.id);
      onMembersChanged(
        channel.id,
        channel.members.filter((m) => m.id !== u.id)
      );
    });

  const leave = () => {
    if (confirm !== "leave") return setConfirm("leave");
    return run(async () => {
      await api.leaveChannel(channel.id);
      onLeft(channel.id);
    });
  };

  const destroy = () => {
    if (confirm !== "delete") return setConfirm("delete");
    return run(async () => {
      await api.deleteChannel(channel.id);
      onDeleted(channel.id);
    });
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 grid place-items-stretch sm:place-items-center z-50 p-0 sm:p-4"
      {...overlayDismiss}
    >
      <div
        role="dialog"
        aria-label={`Détails de ${salonLabel(channel)}`}
        onClick={(e) => e.stopPropagation()}
        className="bg-white text-slate-900 sm:rounded-xl shadow-2xl w-full h-dvh sm:h-auto sm:max-w-lg sm:max-h-[90vh] flex flex-col"
      >
        <div className="px-5 pt-5 flex items-start justify-between gap-3">
          <h2 className="text-xl font-bold min-w-0 break-words">{salonLabel(channel)}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-800 w-8 h-8 shrink-0"
            aria-label="Fermer"
          >
            ✕
          </button>
        </div>
        <div className="px-5 mt-3 flex gap-4 border-b border-slate-200" role="tablist">
          <TabButton active={tab === "about"} onClick={() => setTab("about")}>
            À propos
          </TabButton>
          <TabButton active={tab === "members"} onClick={() => setTab("members")}>
            Membres ({channel.members.length})
          </TabButton>
        </div>

        <div className="p-5 overflow-y-auto flex-1 min-h-0 space-y-4">
          {tab === "about" ? (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (dirty && name.trim()) void save();
              }}
            >
              <label className="block">
                <span className="text-sm font-semibold">Nom</span>
                <input
                  className="mt-1 w-full border rounded-md px-3 py-2 disabled:bg-slate-50 disabled:text-slate-500"
                  value={name}
                  maxLength={80}
                  disabled={!editable}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-sm font-semibold">Description</span>
                <textarea
                  className="mt-1 w-full border rounded-md px-3 py-2 resize-y min-h-16 disabled:bg-slate-50 disabled:text-slate-500"
                  value={description}
                  maxLength={300}
                  disabled={!editable}
                  placeholder={editable ? "De quoi parle ce salon ?" : undefined}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <div>
                <div className="text-sm font-semibold">Visibilité</div>
                {visibilityEditable ? (
                  <div className="mt-1 space-y-1 text-sm">
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="visibility"
                        checked={!isPrivate}
                        onChange={() => setIsPrivate(false)}
                      />
                      Public — tous les membres du chat peuvent le rejoindre
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="visibility"
                        checked={isPrivate}
                        onChange={() => setIsPrivate(true)}
                      />
                      Privé — visible uniquement par ses membres
                    </label>
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-slate-600">
                    {channel.isPrivate
                      ? "Privé — visible uniquement par ses membres."
                      : "Public — tous les membres du chat peuvent le rejoindre."}
                  </p>
                )}
              </div>
              {creator && (
                <p className="text-xs text-slate-500">Créé par {creator.displayName}.</p>
              )}
              {!editable && (
                <p className="text-xs text-slate-500">
                  Seul un administrateur peut modifier le salon par défaut.
                </p>
              )}
              {editable && (
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={busy || !dirty || !name.trim()}
                    className="px-4 py-2 rounded-md bg-aubergine-700 text-white font-medium hover:bg-aubergine-800 disabled:opacity-50"
                  >
                    Enregistrer
                  </button>
                </div>
              )}
            </form>
          ) : (
            <div className="space-y-1">
              {membersEditable && (
                <button
                  type="button"
                  onClick={onAddMembers}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-aubergine-700 hover:bg-slate-100 font-medium"
                >
                  <span className="w-8 h-8 grid place-items-center rounded-md bg-slate-100 text-lg" aria-hidden="true">
                    +
                  </span>
                  Ajouter des personnes
                </button>
              )}
              {channel.members.map((u) => (
                <div key={u.id} className="flex items-center gap-3 px-3 py-2 hover:bg-slate-50 rounded-md">
                  <Avatar user={u} size={32} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {u.displayName}
                      {u.id === currentUser.id ? " (vous)" : ""}
                    </div>
                    <div className="text-xs text-slate-500 truncate">@{u.username}</div>
                  </div>
                  {membersEditable && u.id !== currentUser.id && (
                    <button
                      type="button"
                      onClick={() => void remove(u)}
                      disabled={busy}
                      className="text-xs text-red-600 hover:underline disabled:opacity-50 px-2 py-1"
                    >
                      Retirer
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        {(membersEditable || deletable) && (
          <div className="p-4 border-t border-slate-200 space-y-3">
            {confirm === "leave" && (
              <p className="text-sm text-slate-700">
                {channel.isPrivate && lastOne
                  ? "Vous êtes le dernier membre : le salon et tous ses messages seront supprimés."
                  : channel.isPrivate
                  ? "Vous ne verrez plus ce salon. Un membre pourra vous ajouter à nouveau."
                  : "Le salon disparaîtra de votre liste ; vous pourrez le rejoindre à nouveau."}
              </p>
            )}
            {confirm === "delete" && (
              <p className="text-sm text-red-700">
                Supprimer définitivement {salonLabel(channel)} et tous ses messages, pour tous ses
                membres ?
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              {membersEditable ? (
                <button
                  type="button"
                  onClick={() => void leave()}
                  disabled={busy}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-50 ${
                    confirm === "leave"
                      ? "bg-red-600 text-white hover:bg-red-700"
                      : "text-red-600 hover:bg-red-50"
                  }`}
                >
                  {confirm === "leave" ? "Confirmer : quitter le salon" : "Quitter le salon"}
                </button>
              ) : (
                <span />
              )}
              {deletable && (
                <button
                  type="button"
                  onClick={() => void destroy()}
                  disabled={busy}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-50 ${
                    confirm === "delete"
                      ? "bg-red-600 text-white hover:bg-red-700"
                      : "border border-red-200 text-red-600 hover:bg-red-50"
                  }`}
                >
                  {confirm === "delete" ? "Confirmer la suppression" : "Supprimer le salon"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`pb-2 -mb-px text-sm font-medium border-b-2 ${
        active
          ? "border-aubergine-700 text-aubergine-700"
          : "border-transparent text-slate-500 hover:text-slate-800"
      }`}
    >
      {children}
    </button>
  );
}
