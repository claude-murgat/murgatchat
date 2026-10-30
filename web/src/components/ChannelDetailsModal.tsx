import { useState } from "react";
import { api } from "../api.ts";
import Avatar from "./Avatar.tsx";
import type { Channel, SalonRole, User } from "../types.ts";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss.ts";
import {
  canChangeVisibility,
  canDeleteSalon,
  canEditSalon,
  canManageMembers,
  canManageRoles,
  canRemoveMember,
  hasSalonHeir,
  isBot,
  isOnlySalonAdmin,
  isSalonAdmin,
  salonLabel,
  salonPeople,
} from "../channelRules.ts";

export type DetailsTab = "about" | "members";

// Refus que l'interface ne peut pas toujours éviter (rôle retiré entre-temps par
// un autre admin, deux admins qui se retirent le rôle au même instant, nom du
// salon du pipeline, que le client ne connaît pas…) : dits en clair plutôt
// qu'avec le code du serveur. Les autres codes s'affichent tels quels.
const ERROR_TEXT = new Map([
  ["admin_only", "Seul un admin du salon peut faire cela."],
  ["last_admin", "Le salon doit garder au moins un admin : nommez-en un autre d'abord."],
  ["target_disabled", "Ce compte est désactivé : il ne peut pas être admin du salon."],
  [
    "reserved_name",
    "Le salon du pipeline de support garde son nom : aucun autre salon ne peut le prendre.",
  ],
]);

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
// voir/ajouter/retirer les membres, quitter ; supprimer, changer la
// visibilité, nommer ou retirer des admins et retirer un admin reviennent aux
// admins du salon (et du chat). Le serveur revérifie chaque action.
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
  // Brouillons : null tant qu'on n'a pas touché au champ, qui suit alors le
  // salon en temps réel (un autre membre peut le renommer pendant qu'il est
  // ouvert — « Enregistrer » ne doit pas remettre l'ancien nom).
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null);
  const [privateDraft, setPrivateDraft] = useState<boolean | null>(null);
  const name = nameDraft ?? (channel.name || "");
  const description = descriptionDraft ?? (channel.description || "");
  const isPrivate = privateDraft ?? !!channel.isPrivate;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"leave" | "delete" | "public" | null>(null);

  const editable = canEditSalon(channel, currentUser);
  const visibilityEditable = canChangeVisibility(channel, currentUser);
  const membersEditable = canManageMembers(channel);
  const rolesEditable = canManageRoles(channel, currentUser);
  const deletable = canDeleteSalon(channel, currentUser);
  // La visibilité ne compte que si le lecteur peut encore la changer : un admin
  // du salon à qui l'on retire le rôle pendant qu'il édite perd les boutons
  // radio, son brouillon n'est plus envoyé.
  const dirty =
    name.trim() !== (channel.name || "") ||
    description.trim() !== (channel.description || "") ||
    (visibilityEditable && isPrivate !== !!channel.isPrivate);
  const creator = channel.members.find((m) => m.id === channel.createdById);
  // Le bot qu'un ancien groupe peut compter n'est pas une personne : avec lui
  // seul, le salon privé est supprimé à votre départ et personne ne devient admin.
  const lastOne = salonPeople(channel).length <= 1;
  // Le seul admin qui part laisse le rôle au membre actif le plus ancien
  // (serveur) — s'il en reste un : les comptes désactivés ne le reprennent pas.
  const lastAdminLeaving = !lastOne && isOnlySalonAdmin(channel, currentUser);
  const heirLeft = hasSalonHeir(channel, currentUser);
  // Rendre public un salon privé expose tout son historique à tout le chat :
  // comme quitter ou supprimer, cela se confirme.
  const makingPublic = visibilityEditable && !!channel.isPrivate && !isPrivate;
  const confirmPublic = confirm === "public" && makingPublic;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      // `request()` (api.ts) ne rejette qu'avec des Error : simple vue typée.
      const message = (err as Error).message;
      setError(ERROR_TEXT.get(message) ?? message);
    } finally {
      setBusy(false);
    }
  }

  const save = () => {
    if (makingPublic && confirm !== "public") return setConfirm("public");
    return run(async () => {
      const res = await api.updateChannel(channel.id, {
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
        ...(visibilityEditable ? { isPrivate } : {}),
      });
      onSaved(res.channel);
      setNameDraft(null);
      setDescriptionDraft(null);
      setPrivateDraft(null);
      setConfirm((c) => (c === "public" ? null : c));
    });
  };

  // Changer d'avis sur la visibilité annule une confirmation « rendre public »
  // en attente : elle se redemandera.
  const pickVisibility = (priv: boolean) => {
    setPrivateDraft(priv);
    setConfirm((c) => (c === "public" ? null : c));
  };

  // Nommer admin du salon, ou retirer ce rôle : le salon renvoyé (adminIds à
  // jour) remplace la version locale ; channel:members prévient les autres.
  // Rôle déjà en place : rien n'a changé, la réponse peut ne rien porter.
  const setRole = (u: User, role: SalonRole) =>
    run(async () => {
      const res = await api.setMemberRole(channel.id, u.id, role);
      if (res.channel) onSaved(res.channel);
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
      {/* min-w-0 : sur mobile, sans largeur max, la grille élargirait la fenêtre
          au nom de membre le plus long au lieu de le tronquer — l'écran déborde. */}
      <div
        role="dialog"
        aria-label={`Détails de ${salonLabel(channel)}`}
        onClick={(e) => e.stopPropagation()}
        className="bg-white text-slate-900 sm:rounded-xl shadow-2xl w-full min-w-0 h-dvh sm:h-auto sm:max-w-lg sm:max-h-[90vh] flex flex-col"
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
                  onChange={(e) => setNameDraft(e.target.value)}
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
                  onChange={(e) => setDescriptionDraft(e.target.value)}
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
                        onChange={() => pickVisibility(false)}
                      />
                      Public — tous les membres du chat peuvent le rejoindre
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="visibility"
                        checked={isPrivate}
                        onChange={() => pickVisibility(true)}
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
                  Seul un administrateur du chat peut modifier le salon par défaut.
                </p>
              )}
              {editable && (
                <div className="space-y-2">
                  {confirmPublic && (
                    <p className="text-sm text-slate-700">
                      Rendre ce salon public ? Tout le monde pourra le trouver et lire tout son
                      historique.
                    </p>
                  )}
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={busy || !dirty || !name.trim()}
                      className={`px-4 py-2 rounded-md text-white font-medium disabled:opacity-50 ${
                        confirmPublic
                          ? "bg-red-600 hover:bg-red-700"
                          : "bg-aubergine-700 hover:bg-aubergine-800"
                      }`}
                    >
                      {confirmPublic ? "Confirmer : rendre public" : "Enregistrer"}
                    </button>
                  </div>
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
              {channel.members.map((u) => {
                const admin = isSalonAdmin(channel, u);
                const disabled = u.status === "disabled";
                // Le seul admin garde son rôle : le salon en aurait sinon zéro
                // (le serveur refuserait, 409 last_admin) ; ni le bot ni un compte
                // désactivé ne peuvent être nommés (403 bot_protected,
                // target_disabled).
                const roleButton =
                  rolesEditable &&
                  (admin ? !isOnlySalonAdmin(channel, u) : !isBot(u) && !disabled);
                const removable = canRemoveMember(channel, currentUser, u);
                return (
                  <div key={u.id} className="flex items-center gap-3 px-3 py-2 hover:bg-slate-50 rounded-md">
                    <Avatar user={u} size={32} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate min-w-0">
                          {u.displayName}
                          {u.id === currentUser.id ? " (vous)" : ""}
                        </span>
                        {admin && (
                          <span
                            title="Admin du salon"
                            className="shrink-0 text-[11px] font-semibold text-blue-700 bg-blue-100 rounded-sm px-1.5 py-0.5"
                          >
                            Admin
                          </span>
                        )}
                        {disabled && (
                          <span
                            title="Compte désactivé"
                            className="shrink-0 text-[11px] font-semibold text-slate-600 bg-slate-200 rounded-sm px-1.5 py-0.5"
                          >
                            Désactivé
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 truncate">@{u.username}</div>
                    </div>
                    {(roleButton || removable) && (
                      // Empilés sur mobile : deux boutons côte à côte ne
                      // laisseraient presque plus de place au nom.
                      <div className="shrink-0 flex flex-col items-end sm:flex-row sm:items-center">
                        {roleButton && (
                          <button
                            type="button"
                            onClick={() => void setRole(u, admin ? "member" : "admin")}
                            disabled={busy}
                            className="text-xs text-aubergine-700 hover:underline disabled:opacity-50 px-2 py-1 whitespace-nowrap"
                          >
                            {admin ? "Retirer admin" : "Nommer admin"}
                          </button>
                        )}
                        {removable && (
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
                    )}
                  </div>
                );
              })}
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
                {lastAdminLeaving &&
                  (heirLeft
                    ? " Vous êtes le seul admin : le membre le plus ancien le deviendra."
                    : " Vous êtes le seul admin et les autres membres sont désactivés : le salon restera sans admin.")}
              </p>
            )}
            {/* Le droit de supprimer peut se perdre en direct (rôle d'admin retiré). */}
            {confirm === "delete" && deletable && (
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
