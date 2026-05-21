import { useEffect, useState } from "react";
import { api } from "../api.js";
import Avatar from "./Avatar.jsx";

export default function NewDmModal({ onClose, onOpened, currentUserId }) {
  const [users, setUsers] = useState([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.listUsers(q).then((res) => {
      if (!cancelled) setUsers(res.users.filter((u) => u.id !== currentUserId));
    });
    return () => {
      cancelled = true;
    };
  }, [q, currentUserId]);

  async function pick(u) {
    try {
      const res = await api.openDm(u.id);
      onOpened(res.channel);
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4">
      <div className="bg-white text-slate-900 rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="p-5 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-xl font-bold">Nouveau message</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-800">✕</button>
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
        <div className="px-2 pb-2 overflow-y-auto">
          {users.map((u) => (
            <button
              key={u.id}
              onClick={() => pick(u)}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-slate-100 rounded-md text-left"
            >
              <Avatar user={u} size={32} />
              <div className="flex-1">
                <div className="text-sm font-medium">{u.displayName}</div>
                <div className="text-xs text-slate-500">@{u.username}</div>
              </div>
            </button>
          ))}
          {users.length === 0 && (
            <div className="px-3 py-3 text-sm text-slate-500">Aucun utilisateur</div>
          )}
        </div>
      </div>
    </div>
  );
}
