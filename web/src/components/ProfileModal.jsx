import { useState } from "react";
import { api } from "../api.js";

export default function ProfileModal({ user, onClose, onUpdated }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPassword2, setNewPassword2] = useState("");
  const [busyName, setBusyName] = useState(false);
  const [busyPwd, setBusyPwd] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);

  async function saveName(e) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (!displayName.trim()) {
      setError("Le nom affiché ne peut pas être vide.");
      return;
    }
    if (displayName.trim() === user.displayName) {
      setInfo("Aucun changement.");
      return;
    }
    setBusyName(true);
    try {
      const res = await api.updateProfile({ displayName: displayName.trim() });
      onUpdated(res.user);
      setInfo("Nom affiché mis à jour ✓");
    } catch (err) {
      setError(err.message || "Erreur");
    } finally {
      setBusyName(false);
    }
  }

  async function savePassword(e) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (!currentPassword) {
      setError("Mot de passe actuel requis.");
      return;
    }
    if (newPassword.length < 6) {
      setError("Le nouveau mot de passe doit faire au moins 6 caractères.");
      return;
    }
    if (newPassword !== newPassword2) {
      setError("Les deux nouveaux mots de passe ne correspondent pas.");
      return;
    }
    setBusyPwd(true);
    try {
      await api.updateProfile({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setNewPassword2("");
      setInfo("Mot de passe mis à jour ✓");
    } catch (err) {
      if (err.message === "invalid_current_password") {
        setError("Mot de passe actuel incorrect.");
      } else {
        setError(err.message || "Erreur");
      }
    } finally {
      setBusyPwd(false);
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
        <div className="p-5 border-b border-slate-200">
          <h2 className="text-xl font-bold">Mon profil</h2>
          <p className="text-sm text-slate-500 mt-1">
            {user.username} · {user.email}
          </p>
        </div>
        <div className="p-5 space-y-5 overflow-y-auto">
          <form onSubmit={saveName} className="space-y-2">
            <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
              Nom affiché
            </label>
            <div className="flex gap-2">
              <input
                className="flex-1 border rounded-md px-3 py-2"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={60}
              />
              <button
                type="submit"
                disabled={busyName}
                className="px-3 py-2 rounded-md bg-aubergine-700 text-white font-medium disabled:opacity-50"
              >
                {busyName ? "…" : "Enregistrer"}
              </button>
            </div>
          </form>

          <div className="border-t border-slate-200" />

          <form onSubmit={savePassword} className="space-y-2">
            <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
              Changer de mot de passe
            </label>
            <input
              className="w-full border rounded-md px-3 py-2"
              type="password"
              placeholder="Mot de passe actuel"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
            <input
              className="w-full border rounded-md px-3 py-2"
              type="password"
              placeholder="Nouveau mot de passe"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <input
              className="w-full border rounded-md px-3 py-2"
              type="password"
              placeholder="Nouveau mot de passe (confirmation)"
              autoComplete="new-password"
              value={newPassword2}
              onChange={(e) => setNewPassword2(e.target.value)}
            />
            <button
              type="submit"
              disabled={busyPwd}
              className="w-full px-3 py-2 rounded-md bg-aubergine-700 text-white font-medium disabled:opacity-50"
            >
              {busyPwd ? "…" : "Mettre à jour le mot de passe"}
            </button>
          </form>

          {error && <div className="text-sm text-red-600">{error}</div>}
          {info && <div className="text-sm text-green-700">{info}</div>}
        </div>
        <div className="p-4 border-t border-slate-200 flex justify-end">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md border border-slate-300">
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
