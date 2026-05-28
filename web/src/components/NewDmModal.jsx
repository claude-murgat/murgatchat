import { useEffect, useState } from "react";
import { api } from "../api.js";
import Avatar from "./Avatar.jsx";

export default function NewDmModal({ onClose, onOpened, currentUserId }) {
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // We DO keep the current user in the list now: ticking only yourself opens
    // (or reopens) the "Mes notes" self-DM. The list reorders the caller on top.
    api.listUsers(q).then((res) => {
      if (cancelled) return;
      const sorted = [...res.users].sort((a, b) => {
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
  const othersPicked = selected.size > 0 && !selfPicked;

  function toggle(id) {
    const isSelf = id === currentUserId;
    if (isSelf) {
      // Ticking yourself empties the rest (single-member self-DM).
      setSelected((prev) => (prev.has(id) ? new Set() : new Set([id])));
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(currentUserId); // defensive — disabled above prevents reaching this
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    }
  }

  async function start() {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const res = await api.openDm(Array.from(selected));
      onOpened(res.channel);
    } catch (err) {
      alert(err.message);
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white text-slate-900 rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-xl font-bold">Nouveau message</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-800">
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
            Sélectionnez plusieurs personnes pour créer un groupe.
          </p>
        </div>
        <div className="px-2 pb-2 overflow-y-auto flex-1">
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
                  onChange={() => toggle(u.id)}
                />
                <Avatar user={u} size={32} />
                <div className="flex-1">
                  <div className="text-sm font-medium">
                    {isMe ? "📝 Mes notes" : u.displayName}
                    {isMe && (
                      <span className="ml-1 text-xs text-slate-500 font-normal">
                        (notes pour vous-même)
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">@{u.username}</div>
                </div>
              </label>
            );
          })}
          {users.length === 0 && (
            <div className="px-3 py-3 text-sm text-slate-500">Aucun utilisateur</div>
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
            onClick={start}
            disabled={busy || selected.size === 0}
            className="px-3 py-1.5 rounded-md bg-aubergine-700 text-white font-medium hover:bg-aubergine-800 disabled:opacity-50"
          >
            {selected.size > 1 ? `Créer le groupe (${selected.size})` : "Démarrer"}
          </button>
        </div>
      </div>
    </div>
  );
}
