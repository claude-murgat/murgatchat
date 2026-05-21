import { useState } from "react";
import { api } from "../api.js";
import Avatar from "./Avatar.jsx";

export default function MembersModal({
  channel,
  currentUser,
  onClose,
  onLeft,
  onMembersChanged,
}) {
  const [members, setMembers] = useState(channel.members || []);
  const [busy, setBusy] = useState(false);
  const canManage = !channel.isDefault;

  async function remove(u) {
    setBusy(true);
    try {
      await api.removeMember(channel.id, u.id);
      const next = members.filter((m) => m.id !== u.id);
      setMembers(next);
      onMembersChanged?.(channel.id, next);
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    if (!window.confirm(`Quitter #${channel.name} ?`)) return;
    setBusy(true);
    try {
      await api.leaveChannel(channel.id);
      onLeft(channel.id);
    } catch (e) {
      alert(e.message);
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
          <h2 className="text-xl font-bold">
            Membres {channel.name ? `de #${channel.name}` : ""} ({members.length})
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-800">
            ✕
          </button>
        </div>
        <div className="px-2 py-2 overflow-y-auto flex-1">
          {members.map((u) => (
            <div
              key={u.id}
              className="flex items-center gap-3 px-3 py-2 hover:bg-slate-50 rounded-md"
            >
              <Avatar user={u} size={32} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">
                  {u.displayName}
                  {u.id === currentUser.id ? " (vous)" : ""}
                </div>
                <div className="text-xs text-slate-500">@{u.username}</div>
              </div>
              {canManage && u.id !== currentUser.id && (
                <button
                  onClick={() => remove(u)}
                  disabled={busy}
                  className="text-xs text-red-600 hover:underline disabled:opacity-50"
                >
                  Retirer
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="p-4 border-t border-slate-200 flex justify-between items-center">
          {canManage ? (
            <button
              onClick={leave}
              disabled={busy}
              className="text-sm text-red-600 font-medium hover:underline disabled:opacity-50"
            >
              Quitter le salon
            </button>
          ) : (
            <span className="text-xs text-slate-400">Salon par défaut</span>
          )}
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md border border-slate-300"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
