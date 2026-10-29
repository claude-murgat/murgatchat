import { useEffect, useState } from "react";
import { api } from "../api.ts";
import Avatar from "./Avatar.tsx";
import type { Channel, User } from "../types.ts";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss.ts";

interface NewChannelModalProps {
  onClose: () => void;
  /** Reçoit le salon créé (ouvert ensuite), après l'étape d'ajout de personnes. */
  onCreated: (channel: Channel) => void;
  currentUserId: string;
  /** Nom pré-rempli (création depuis la recherche). */
  initialName?: string;
}

const NAME_MAX = 80;

// Création d'un salon en trois temps, comme Slack : le nom, la visibilité, puis
// les personnes à ajouter (« Ignorer pour l'instant »). Le salon est créé à la
// fin de l'étape 2 ; les ajouts de l'étape 3 passent par l'ajout de membres
// ordinaire, donc laissent leur trace dans le salon.
export default function NewChannelModal({
  onClose,
  onCreated,
  currentUserId,
  initialName = "",
}: NewChannelModalProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState(initialName.slice(0, NAME_MAX));
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [created, setCreated] = useState<Channel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Une fois le salon créé, fermer la fenêtre l'ouvre quand même : il existe.
  const close = () => (created ? onCreated(created) : onClose());
  const overlayDismiss = useOverlayDismiss(close);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.createChannel({
        name: name.trim(),
        description: description.trim() || undefined,
        isPrivate,
      });
      setCreated(res.channel);
      setStep(3);
    } catch (err) {
      // `request()` (api.ts) ne rejette qu'avec des Error : simple vue typée.
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const title = step === 3 && created ? "Ajouter des personnes" : "Créer un salon";
  const prefix = isPrivate ? "🔒" : "#";

  return (
    <div
      className="fixed inset-0 bg-black/50 grid place-items-stretch sm:place-items-center z-50 p-0 sm:p-4"
      {...overlayDismiss}
    >
      <div
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="bg-white text-slate-900 sm:rounded-xl shadow-2xl w-full h-dvh sm:h-auto sm:max-w-lg sm:max-h-[90vh] flex flex-col"
      >
        <div className="p-5 border-b border-slate-200 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-bold">{title}</h2>
            {step > 1 && (
              <div className="text-sm text-slate-500 truncate">
                {prefix} {created?.name || name.trim()}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            className="text-slate-500 hover:text-slate-800 w-8 h-8 shrink-0"
            aria-label="Fermer"
          >
            ✕
          </button>
        </div>

        {step === 1 && (
          <form
            className="flex flex-col flex-1 min-h-0"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) setStep(2);
            }}
          >
            <div className="p-5 space-y-4 overflow-y-auto flex-1">
              <label className="block">
                <span className="font-semibold text-sm">Nom</span>
                <div className="mt-1 flex items-center gap-2 border rounded-md px-3 py-2 focus-within:ring-2 focus-within:ring-slackblue">
                  <span className="text-slate-500" aria-hidden="true">
                    {prefix}
                  </span>
                  <input
                    autoFocus
                    className="flex-1 min-w-0 outline-hidden"
                    placeholder="ex. projet-chantier"
                    value={name}
                    maxLength={NAME_MAX}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <span className="text-xs text-slate-400 tabular-nums">
                    {NAME_MAX - name.length}
                  </span>
                </div>
                <span className="block text-xs text-slate-500 mt-1">
                  Les conversations autour d'un thème ont lieu dans les salons. Choisissez un nom
                  simple et clair.
                </span>
              </label>
              <label className="block">
                <span className="font-semibold text-sm">
                  Description <span className="font-normal text-slate-500">(facultatif)</span>
                </span>
                <input
                  className="mt-1 w-full border rounded-md px-3 py-2"
                  placeholder="De quoi parle ce salon ?"
                  value={description}
                  maxLength={300}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
            </div>
            <div className="p-4 border-t border-slate-200 flex items-center justify-between gap-2">
              <span className="text-xs text-slate-500">Étape 1 sur 2</span>
              <button
                type="submit"
                disabled={!name.trim()}
                className="px-4 py-2 rounded-md bg-aubergine-700 text-white font-medium hover:bg-aubergine-800 disabled:opacity-50"
              >
                Suivant
              </button>
            </div>
          </form>
        )}

        {step === 2 && (
          <form
            className="flex flex-col flex-1 min-h-0"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <div
              role="radiogroup"
              aria-labelledby="new-salon-visibility"
              className="p-5 space-y-3 overflow-y-auto flex-1"
            >
              <div id="new-salon-visibility" className="font-semibold text-sm">
                Visibilité
              </div>
              <VisibilityOption
                checked={!isPrivate}
                onChange={() => setIsPrivate(false)}
                title="Public"
                detail="Tous les membres du chat peuvent le trouver et le rejoindre."
              />
              <VisibilityOption
                checked={isPrivate}
                onChange={() => setIsPrivate(true)}
                title="Privé"
                detail="Uniquement les personnes ajoutées : il n'apparaît pas pour les autres."
              />
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
            <div className="p-4 border-t border-slate-200 flex items-center justify-between gap-2">
              <span className="text-xs text-slate-500">Étape 2 sur 2</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="px-4 py-2 rounded-md border border-slate-300"
                >
                  Retour
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 rounded-md bg-aubergine-700 text-white font-medium hover:bg-aubergine-800 disabled:opacity-50"
                >
                  Créer
                </button>
              </div>
            </div>
          </form>
        )}

        {step === 3 && created && (
          <PeoplePicker
            channel={created}
            currentUserId={currentUserId}
            onDone={(channel) => onCreated(channel)}
          />
        )}
      </div>
    </div>
  );
}

interface VisibilityOptionProps {
  checked: boolean;
  onChange: () => void;
  title: string;
  detail: string;
}

function VisibilityOption({ checked, onChange, title, detail }: VisibilityOptionProps) {
  return (
    <label
      className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer ${
        checked ? "border-slackblue bg-slackblue/5" : "border-slate-200 hover:bg-slate-50"
      }`}
    >
      <input
        type="radio"
        name="visibility"
        checked={checked}
        onChange={onChange}
        className="mt-1"
      />
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-sm text-slate-500">{detail}</span>
      </span>
    </label>
  );
}

interface PeoplePickerProps {
  channel: Channel;
  currentUserId: string;
  onDone: (channel: Channel) => void;
}

// Étape 3 : ajouter des personnes au salon tout juste créé, ou passer.
function PeoplePicker({ channel, currentUserId, onDone }: PeoplePickerProps) {
  const [users, setUsers] = useState<User[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.listUsers(q).then((res) => {
      if (!cancelled) setUsers(res.users.filter((u: User) => u.id !== currentUserId));
    });
    return () => {
      cancelled = true;
    };
  }, [q, currentUserId]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function add() {
    setBusy(true);
    try {
      const res = await api.addMembers(channel.id, Array.from(selected));
      onDone(res.channel);
    } catch (err) {
      alert((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="p-4">
        <input
          autoFocus
          className="w-full border rounded-md px-3 py-2"
          placeholder="Saisir un nom"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="px-2 pb-2 overflow-y-auto flex-1 min-h-0 sm:max-h-80">
        {users.map((u) => (
          <label
            key={u.id}
            className="flex items-center gap-3 px-3 py-2 hover:bg-slate-100 rounded-md cursor-pointer"
          >
            <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggle(u.id)} />
            <Avatar user={u} size={32} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{u.displayName}</div>
              <div className="text-xs text-slate-500 truncate">@{u.username}</div>
            </div>
          </label>
        ))}
        {users.length === 0 && (
          <div className="px-3 py-3 text-sm text-slate-500">Aucun utilisateur</div>
        )}
      </div>
      <div className="p-4 border-t border-slate-200 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onDone(channel)}
          className="px-4 py-2 rounded-md border border-slate-300"
        >
          Ignorer pour l'instant
        </button>
        <button
          type="button"
          onClick={add}
          disabled={busy || selected.size === 0}
          className="px-4 py-2 rounded-md bg-aubergine-700 text-white font-medium hover:bg-aubergine-800 disabled:opacity-50"
        >
          Ajouter{selected.size > 0 ? ` (${selected.size})` : ""}
        </button>
      </div>
    </>
  );
}
