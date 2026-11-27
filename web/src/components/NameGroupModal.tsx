import { useState } from "react";
import { api } from "../api.ts";
import type { Channel } from "../types.ts";

// Refus que l'interface ne peut pas toujours éviter, dits en clair plutôt
// qu'avec le code du serveur (mêmes cas que ChannelDetailsModal).
const ERROR_TEXT = new Map([
  ["admin_only", "Seul un admin du salon peut faire cela."],
  [
    "reserved_name",
    "Le salon du pipeline de support garde son nom : aucun autre salon ne peut le prendre.",
  ],
]);

const NAME_MAX = 80;

interface NameGroupModalProps {
  /** Le salon sans nom à nommer (son créateur l'a ouvert). */
  channel: Channel;
  /** Reçoit le salon renommé (met à jour la liste), fenêtre fermée. */
  onSaved: (channel: Channel) => void;
}

// Nommage obligatoire d'un salon sans nom, demandé à son créateur à l'ouverture
// (voir needsGroupName). La fenêtre ne propose que d'enregistrer un nom : pas
// d'annulation ni de fermeture au clic en dehors — le nom d'un salon est
// obligatoire (le serveur le vérifie aussi, à la création comme ici).
export default function NameGroupModal({ channel, onSaved }: NameGroupModalProps) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();

  async function save() {
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.updateChannel(channel.id, { name: trimmed });
      onSaved(res.channel);
    } catch (err) {
      // `request()` (api.ts) ne rejette qu'avec des Error : simple vue typée.
      const message = (err as Error).message;
      setError(ERROR_TEXT.get(message) ?? message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-stretch sm:place-items-center z-50 p-0 sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Nommer le salon"
        className="bg-white text-slate-900 sm:rounded-xl shadow-2xl w-full h-dvh sm:h-auto sm:max-w-md flex flex-col"
      >
        <div className="p-5 border-b border-slate-200">
          <h2 className="text-xl font-bold">Nommez ce salon</h2>
        </div>
        <form
          className="flex flex-col flex-1 min-h-0"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="p-5 space-y-3 overflow-y-auto flex-1">
            <p className="text-sm text-slate-600">
              Ce salon n'a pas encore de nom. En tant que créateur, donnez-lui un nom avant de
              continuer : il aidera ses membres à le reconnaître.
            </p>
            <label className="block">
              <span className="text-sm font-semibold">Nom du salon</span>
              <input
                autoFocus
                className="mt-1 w-full border rounded-md px-3 py-2"
                placeholder="ex. projet-chantier"
                value={name}
                maxLength={NAME_MAX}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
          <div className="p-4 border-t border-slate-200 flex justify-end">
            <button
              type="submit"
              disabled={busy || !trimmed}
              className="px-4 py-2 rounded-md bg-aubergine-700 text-white font-medium hover:bg-aubergine-800 disabled:opacity-50"
            >
              Enregistrer
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
