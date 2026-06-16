import { useMemo, useState } from "react";
import { api } from "../api.js";
import { getDiagnostics, getLogLines, dumpText, entryCount } from "../logbuffer.js";

// "Signaler un bug" — universal (web / PWA / desktop). Lets the user describe
// the problem and (optionally) attach the captured diagnostic logs, which are
// stored server-side for admins to triage. App version + platform always go
// along (harmless, and the first thing an admin needs); detailed logs only when
// the box is ticked. The user can preview exactly what's sent.
export default function BugReportModal({ user, onClose }) {
  const [message, setMessage] = useState("");
  const [attachLogs, setAttachLogs] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);

  // Snapshot the diagnostics + logs once when the modal opens, so the preview
  // and the submitted payload are consistent.
  const snapshot = useMemo(
    () => ({
      diagnostics: getDiagnostics(),
      logs: getLogLines(),
      text: dumpText(),
      count: entryCount(),
    }),
    []
  );

  async function copyLogs() {
    setError(null);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(snapshot.text);
      } else {
        // Fallback for older/iOS webviews without the async clipboard API.
        const ta = document.createElement("textarea");
        ta.value = snapshot.text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copie impossible — sélectionnez le texte de l'aperçu manuellement.");
      setShowPreview(true);
    }
  }

  function downloadLogs() {
    try {
      const blob = new Blob([snapshot.text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      a.href = url;
      a.download = `chat-diagnostic-${stamp}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError("Téléchargement impossible sur cette plateforme.");
    }
  }

  async function submit() {
    const text = message.trim();
    if (!text) {
      setError("Décrivez le problème avant d'envoyer.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.reportBug({
        message: text,
        // Version + platform are always useful and harmless to share.
        appVersion: snapshot.diagnostics.appVersion,
        platform: snapshot.diagnostics.platform,
        // Detailed logs + full diagnostics only when the user agrees.
        ...(attachLogs
          ? { logs: snapshot.logs, diagnostics: snapshot.diagnostics }
          : {}),
      });
      setDone(true);
    } catch (e) {
      setError(e?.data?.error || e?.message || "Échec de l'envoi — réessayez.");
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
        className="bg-white text-slate-900 sm:rounded-xl shadow-2xl w-full h-full sm:h-auto sm:max-w-lg sm:max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-slate-200">
          <h2 className="text-lg font-bold">🐞 Signaler un bug</h2>
          <p className="text-sm text-slate-500">
            Décrivez ce qui s'est passé. Les logs aident à diagnostiquer plus vite.
          </p>
        </div>

        {done ? (
          <div className="p-6 flex-1 flex flex-col items-center justify-center text-center gap-3">
            <div className="text-4xl">✅</div>
            <div className="font-semibold">Merci, votre rapport a été envoyé.</div>
            <p className="text-sm text-slate-500">
              Un administrateur pourra le consulter. Vous pouvez fermer cette fenêtre.
            </p>
            <button
              onClick={onClose}
              className="mt-2 px-4 py-2 rounded-md bg-aubergine-700 text-white text-sm"
            >
              Fermer
            </button>
          </div>
        ) : (
          <>
            <div className="p-5 space-y-4 overflow-y-auto">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Que s'est-il passé&nbsp;?
                </label>
                <textarea
                  autoFocus
                  rows={5}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Ex. : en cliquant sur un salon, l'app reste bloquée sur l'écran de chargement…"
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-aubergine-400"
                />
              </div>

              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={attachLogs}
                  onChange={(e) => setAttachLogs(e.target.checked)}
                />
                <span>
                  <span className="font-medium">
                    Joindre les logs de diagnostic ({snapshot.count} ligne
                    {snapshot.count > 1 ? "s" : ""})
                  </span>
                  <span className="block text-[12px] text-slate-500">
                    Événements techniques (connexions, erreurs) et infos appareil. Aucun
                    contenu de message n'est inclus. La version et la plateforme sont
                    toujours jointes.
                  </span>
                </span>
              </label>

              <div className="flex flex-wrap gap-2 text-sm">
                <button
                  type="button"
                  onClick={() => setShowPreview((s) => !s)}
                  className="px-2.5 py-1.5 rounded border border-slate-300 hover:bg-slate-50"
                >
                  {showPreview ? "Masquer l'aperçu" : "Voir ce qui sera envoyé"}
                </button>
                <button
                  type="button"
                  onClick={copyLogs}
                  className="px-2.5 py-1.5 rounded border border-slate-300 hover:bg-slate-50"
                >
                  {copied ? "Copié ✓" : "Copier les logs"}
                </button>
                <button
                  type="button"
                  onClick={downloadLogs}
                  className="px-2.5 py-1.5 rounded border border-slate-300 hover:bg-slate-50"
                >
                  Télécharger .txt
                </button>
              </div>

              {showPreview && (
                <pre className="text-[11px] leading-snug bg-slate-50 border border-slate-200 rounded-md p-3 max-h-56 overflow-auto whitespace-pre-wrap break-words text-slate-700">
                  {snapshot.text}
                </pre>
              )}

              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>

            <div className="p-3 border-t border-slate-200 flex justify-end gap-2">
              <button
                onClick={onClose}
                disabled={busy}
                className="px-3 py-1.5 rounded border border-slate-300 text-sm disabled:opacity-50"
              >
                Annuler
              </button>
              <button
                onClick={submit}
                disabled={busy || !message.trim()}
                className="px-4 py-1.5 rounded-md bg-aubergine-700 text-white text-sm disabled:opacity-50"
              >
                {busy ? "Envoi…" : "Envoyer"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
