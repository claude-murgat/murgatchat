import { useEffect, useState } from "react";
import { api } from "../api.js";

export default function InviteModal({ onClose }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { link, emailSent, token }
  const [invitations, setInvitations] = useState([]);

  async function refresh() {
    try {
      const r = await api.listInvitations();
      setInvitations(r.invitations);
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.createInvitation(email.trim());
      setResult({ link: res.link, emailSent: res.emailSent, token: res.token });
      setEmail("");
      refresh();
    } catch (err) {
      setError(err.message || "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-stretch sm:place-items-center z-50 p-0 sm:p-4" onClick={onClose}>
      <div
        className="bg-white text-slate-900 sm:rounded-xl shadow-2xl w-full h-full sm:h-auto sm:max-w-lg sm:max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-slate-200">
          <h2 className="text-xl font-bold">Inviter un utilisateur</h2>
          <p className="text-sm text-slate-500 mt-1">
            Un e-mail d'invitation est envoyé ; vous pouvez aussi partager le lien/code.
          </p>
        </div>
        <form onSubmit={submit} className="p-5 space-y-3">
          <div className="flex gap-2">
            <input
              className="flex-1 border rounded-md px-3 py-2"
              type="email"
              placeholder="email@exemple.fr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="px-3 py-2 rounded-md bg-aubergine-700 text-white font-medium disabled:opacity-50"
            >
              {busy ? "…" : "Inviter"}
            </button>
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
          {result && (
            <div className="text-sm bg-slate-50 border border-slate-200 rounded-md p-3 space-y-1">
              <div className={result.emailSent ? "text-green-600" : "text-amber-600"}>
                {result.emailSent
                  ? "E-mail envoyé ✓"
                  : "E-mail non envoyé (SMTP non configuré) — partagez le lien :"}
              </div>
              {result.link && <div className="break-all text-aubergine-700">{result.link}</div>}
              <div className="text-slate-500">
                Code : <span className="font-mono">{result.token}</span>
              </div>
            </div>
          )}
        </form>
        <div className="px-5 pb-2 overflow-y-auto">
          <div className="text-xs font-semibold text-slate-500 uppercase mb-1">Invitations</div>
          <div className="border rounded-md divide-y max-h-48 overflow-y-auto">
            {invitations.length === 0 && (
              <div className="px-3 py-2 text-sm text-slate-500">Aucune invitation</div>
            )}
            {invitations.map((i) => (
              <div key={i.id} className="px-3 py-2 text-sm flex items-center justify-between gap-2">
                <span className="truncate">{i.email}</span>
                <span
                  className={`text-xs whitespace-nowrap ${
                    i.acceptedAt ? "text-green-600" : i.pending ? "text-amber-600" : "text-slate-400"
                  }`}
                >
                  {i.acceptedAt ? "Inscrit" : i.pending ? "En attente" : "Expirée"}
                </span>
              </div>
            ))}
          </div>
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
