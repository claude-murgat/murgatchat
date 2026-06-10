import { useEffect, useState } from "react";
import { api } from "../api.js";
import Avatar from "./Avatar.jsx";

export default function NewChannelModal({ onClose, onCreated, currentUserId }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.listUsers(q).then((res) => {
      if (!cancelled) setUsers(res.users.filter((u) => u.id !== currentUserId));
    });
    return () => {
      cancelled = true;
    };
  }, [q, currentUserId]);

  function toggle(id) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  }

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await api.createChannel({
        name: name.trim(),
        description: description.trim() || undefined,
        isPrivate,
        memberIds: Array.from(selected),
      });
      onCreated(res.channel);
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 grid place-items-stretch sm:place-items-center z-50 p-0 sm:p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="bg-white text-slate-900 sm:rounded-xl shadow-2xl w-full h-full sm:h-auto sm:max-w-lg sm:max-h-[90vh] flex flex-col"
      >
        <div className="p-5 border-b border-slate-200">
          <h2 className="text-xl font-bold">Créer une conversation</h2>
        </div>
        <div className="p-5 space-y-3 overflow-y-auto">
          <input
            className="w-full border rounded-md px-3 py-2"
            placeholder="Nom du salon (ex. marketing)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <input
            className="w-full border rounded-md px-3 py-2"
            placeholder="Description (optionnel)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
            />
            Salon privé
          </label>

          <div className="pt-3">
            <div className="font-semibold text-sm mb-1">Ajouter des membres</div>
            <input
              className="w-full border rounded-md px-3 py-2 mb-2"
              placeholder="Rechercher..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="max-h-48 overflow-y-auto border rounded-md divide-y">
              {users.map((u) => (
                <label
                  key={u.id}
                  className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(u.id)}
                    onChange={() => toggle(u.id)}
                  />
                  <Avatar user={u} size={28} />
                  <div className="flex-1">
                    <div className="text-sm font-medium">{u.displayName}</div>
                    <div className="text-xs text-slate-500">@{u.username}</div>
                  </div>
                </label>
              ))}
              {users.length === 0 && (
                <div className="px-2 py-3 text-sm text-slate-500">Aucun utilisateur</div>
              )}
            </div>
          </div>
        </div>
        <div className="p-4 border-t border-slate-200 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md border border-slate-300"
          >
            Annuler
          </button>
          <button
            type="submit"
            disabled={busy}
            className="px-3 py-1.5 rounded-md bg-aubergine-700 text-white font-medium hover:bg-aubergine-800 disabled:opacity-60"
          >
            Créer
          </button>
        </div>
      </form>
    </div>
  );
}
