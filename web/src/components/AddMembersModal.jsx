import { useEffect, useState } from "react";
import { api } from "../api.js";
import Avatar from "./Avatar.jsx";

export default function AddMembersModal({ channel, currentUserId, onClose, onAdded }) {
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  const memberIds = new Set((channel.members || []).map((m) => m.id));

  useEffect(() => {
    let cancelled = false;
    api.listUsers(q).then((res) => {
      if (!cancelled) {
        setUsers(
          res.users.filter((u) => u.id !== currentUserId && !memberIds.has(u.id))
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [q]);

  function toggle(id) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  }

  async function submit() {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const res = await api.addMembers(channel.id, Array.from(selected));
      onAdded(res.channel);
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 grid place-items-stretch sm:place-items-center z-50 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white text-slate-900 sm:rounded-xl shadow-2xl w-full h-full sm:h-auto sm:max-w-md sm:max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-xl font-bold">
            Ajouter des membres {channel.name ? `à #${channel.name}` : ""}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-800">
            ✕
          </button>
        </div>
        <div className="p-4">
          <input
            autoFocus
            className="w-full border rounded-md px-3 py-2"
            placeholder="Rechercher quelqu'un..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="px-2 pb-2 overflow-y-auto flex-1">
          {users.map((u) => (
            <label
              key={u.id}
              className="flex items-center gap-3 px-3 py-2 hover:bg-slate-100 rounded-md cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.has(u.id)}
                onChange={() => toggle(u.id)}
              />
              <Avatar user={u} size={32} />
              <div className="flex-1">
                <div className="text-sm font-medium">{u.displayName}</div>
                <div className="text-xs text-slate-500">@{u.username}</div>
              </div>
            </label>
          ))}
          {users.length === 0 && (
            <div className="px-3 py-3 text-sm text-slate-500">
              Aucun utilisateur à ajouter.
            </div>
          )}
        </div>
        <div className="p-4 border-t border-slate-200 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md border border-slate-300"
          >
            Annuler
          </button>
          <button
            onClick={submit}
            disabled={busy || selected.size === 0}
            className="px-3 py-1.5 rounded-md bg-aubergine-700 text-white font-medium hover:bg-aubergine-800 disabled:opacity-50"
          >
            Ajouter{selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
