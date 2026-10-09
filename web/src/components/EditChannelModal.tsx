import { useState } from "react";
import { api } from "../api.ts";
import type { Channel } from "../types.ts";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss.ts";

interface EditChannelModalProps {
  channel: Channel;
  onClose: () => void;
  onSaved: (channel: Channel) => void;
  onDeleted: (channelId: string) => void;
}

export default function EditChannelModal({
  channel,
  onClose,
  onSaved,
  onDeleted,
}: EditChannelModalProps) {
  const overlayDismiss = useOverlayDismiss(onClose);
  const [name, setName] = useState(channel.name || "");
  const [description, setDescription] = useState(channel.description || "");
  const [isPrivate, setIsPrivate] = useState(!!channel.isPrivate);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await api.updateChannel(channel.id, {
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
        // Le salon par défaut reste public : on n'envoie pas isPrivate.
        ...(channel.isDefault ? {} : { isPrivate }),
      });
      onSaved(res.channel);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    try {
      await api.deleteChannel(channel.id);
      onDeleted(channel.id);
    } catch (err) {
      alert((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 grid place-items-stretch sm:place-items-center z-50 p-0 sm:p-4"
      {...overlayDismiss}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="bg-white text-slate-900 sm:rounded-xl shadow-2xl w-full h-dvh sm:h-auto sm:max-w-md sm:max-h-[90vh] flex flex-col"
      >
        <div className="p-5 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-xl font-bold">Modifier le salon</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-800"
            aria-label="Fermer"
          >
            ✕
          </button>
        </div>
        <div className="p-5 space-y-3 overflow-y-auto">
          <label className="block">
            <span className="block text-sm font-medium mb-1">Nom du salon</span>
            <input
              className="w-full border rounded-md px-3 py-2"
              placeholder="Nom du salon"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
            />
          </label>
          <label className="block">
            <span className="block text-sm font-medium mb-1">Description (optionnel)</span>
            <input
              className="w-full border rounded-md px-3 py-2"
              placeholder="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={300}
            />
          </label>
          {!channel.isDefault && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isPrivate}
                onChange={(e) => setIsPrivate(e.target.checked)}
              />
              Salon privé
            </label>
          )}
          {channel.isDefault && (
            <p className="text-xs text-slate-500">
              Salon par défaut : il ne peut être ni supprimé ni rendu privé.
            </p>
          )}
          {confirmDelete && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              Supprimer définitivement #{channel.name} et tous ses messages&nbsp;?
              Cliquez à nouveau sur «&nbsp;Supprimer&nbsp;» pour confirmer.
            </p>
          )}
        </div>
        <div className="p-4 border-t border-slate-200 flex justify-between gap-2">
          {!channel.isDefault ? (
            <button
              type="button"
              onClick={destroy}
              disabled={busy}
              className={`px-3 py-1.5 rounded-md font-medium disabled:opacity-60 ${
                confirmDelete
                  ? "bg-red-600 text-white hover:bg-red-700"
                  : "border border-red-300 text-red-600 hover:bg-red-50"
              }`}
            >
              {confirmDelete ? "Confirmer la suppression" : "Supprimer"}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-md border border-slate-300"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="px-3 py-1.5 rounded-md bg-aubergine-700 text-white font-medium hover:bg-aubergine-800 disabled:opacity-60"
            >
              Enregistrer
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
