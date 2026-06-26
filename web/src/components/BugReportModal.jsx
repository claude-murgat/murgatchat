import { useMemo, useRef, useState, useEffect } from "react";
import { api } from "../api.js";
import { getDiagnostics, getLogLines, dumpText, entryCount } from "../logbuffer.js";

// "Signaler un bug" — universal (web / PWA / desktop). The user describes the
// problem and then refines it in a short conversation with Claude (server-side);
// once the demand is clear, Claude finalizes it, which creates the ticket + the
// GitHub issue that drives the triage → fix pipeline. App version + platform
// always go along; detailed logs only when the box is ticked.
//
// Graceful fallback: if the support chat is disabled (no API key) or errors, the
// first message is sent as a plain one-shot report instead — the historical
// behavior — so reporting a bug never depends on the chat being available.
// Attachment limits (issue #96). Screenshots are the stated use case, so we
// allow images only; the count/size caps mirror the server's MAX_ATTACHMENTS and
// stay well under the /uploads route's 25 MiB hard limit.
const MAX_ATTACHMENTS = 3;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 Mo

export default function BugReportModal({ user, onClose }) {
  // "compose" → first message form · "chat" → conversation · "done" → success.
  const [phase, setPhase] = useState("compose");
  const [message, setMessage] = useState("");
  const [attachLogs, setAttachLogs] = useState(true);
  const [files, setFiles] = useState([]); // pending screenshots, uploaded on send
  const fileInputRef = useRef(null);
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  // Conversation state (chat phase).
  const [conversationId, setConversationId] = useState(null);
  const [thread, setThread] = useState([]); // [{ role, content }]
  const [input, setInput] = useState("");

  const scrollRef = useRef(null);

  // Snapshot diagnostics + logs once when the modal opens, so the preview and
  // the submitted payload stay consistent across turns.
  const snapshot = useMemo(
    () => ({
      diagnostics: getDiagnostics(),
      logs: getLogLines(),
      text: dumpText(),
      count: entryCount(),
    }),
    []
  );

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [thread, phase, busy]);

  // Logs/diagnostics payload — only attached when the user agrees.
  function logsPayload() {
    return attachLogs
      ? { logs: snapshot.logs, diagnostics: snapshot.diagnostics }
      : {};
  }

  async function copyLogs() {
    setError(null);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(snapshot.text);
      } else {
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

  // Add picked files to the pending list, rejecting non-images, too-large files,
  // and anything beyond the count cap — with a clear message for each case.
  function onPickFiles(e) {
    const picked = Array.from(e.target.files || []);
    e.target.value = ""; // let the same file be re-picked after a removal
    if (!picked.length) return;
    setError(null);
    setFiles((prev) => {
      let next = prev;
      for (const f of picked) {
        if (!f.type.startsWith("image/")) {
          setError("Seules les images sont acceptées (captures d'écran).");
          continue;
        }
        if (f.size > MAX_FILE_BYTES) {
          setError("Chaque image doit faire moins de 5 Mo.");
          continue;
        }
        if (next.length >= MAX_ATTACHMENTS) {
          setError(`${MAX_ATTACHMENTS} pièces jointes au maximum.`);
          break;
        }
        if (next.some((p) => p.name === f.name && p.size === f.size)) continue; // dedupe
        next = [...next, f];
      }
      return next;
    });
  }

  function removeFile(idx) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  // Upload the pending screenshots (if any) and return their attachment ids, to
  // be sent alongside the report. Throws on failure so the caller can stop.
  async function uploadAttachments() {
    if (!files.length) return [];
    const uploaded = await Promise.all(files.map((f) => api.uploadFile(f)));
    return uploaded.map((a) => a.id);
  }

  // Last resort when the chat is unavailable: file a plain one-shot report.
  async function oneShotFallback(text, attachmentIds = []) {
    await api.reportBug({
      message: text,
      appVersion: snapshot.diagnostics.appVersion,
      platform: snapshot.diagnostics.platform,
      ...logsPayload(),
      attachmentIds,
    });
    setPhase("done");
  }

  // Start: try the conversation; fall back to a one-shot report on 503/502/network.
  async function start() {
    const text = message.trim();
    if (!text) {
      setError("Décrivez le problème avant d'envoyer.");
      return;
    }
    setBusy(true);
    setError(null);
    // Upload screenshots first (while still on the compose screen) so a failure
    // here keeps the form — with its file list — intact for a retry.
    let attachmentIds;
    try {
      attachmentIds = await uploadAttachments();
    } catch {
      setError("Échec de l'envoi des pièces jointes — réessayez ou retirez-les.");
      setBusy(false);
      return;
    }
    // Switch to the conversation view right away, echoing the user's first
    // message, so the thinking indicator below makes the (possibly several
    // seconds) wait for Claude's first reply read as "in progress", not frozen.
    setThread([{ role: "user", content: text }]);
    setPhase("chat");
    try {
      const res = await api.startSupport({
        message: text,
        appVersion: snapshot.diagnostics.appVersion,
        platform: snapshot.diagnostics.platform,
        ...logsPayload(),
        attachmentIds,
      });
      setConversationId(res.id);
      setThread(res.messages || []);
      if (res.status === "submitted") setPhase("done");
    } catch (e) {
      const code = e?.data?.error;
      if (code === "support_chat_unavailable" || code === "support_chat_error") {
        try {
          await oneShotFallback(text, attachmentIds);
          return;
        } catch (e2) {
          setError(e2?.data?.error || e2?.message || "Échec de l'envoi — réessayez.");
          setPhase("compose");
        }
      } else {
        setError(e?.data?.error || e?.message || "Échec de l'envoi — réessayez.");
        setPhase("compose");
      }
    } finally {
      setBusy(false);
    }
  }

  // Continue the conversation.
  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    // Optimistic echo so the user sees their message immediately.
    setThread((t) => [...t, { role: "user", content: text }]);
    setInput("");
    try {
      const res = await api.sendSupport(conversationId, { message: text });
      setThread(res.messages || []);
      if (res.status === "submitted") setPhase("done");
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
            {phase === "chat"
              ? "Précisez votre demande avec l'assistant. Le ticket sera transmis à l'équipe."
              : "Décrivez ce qui s'est passé. Les logs aident à diagnostiquer plus vite."}
          </p>
        </div>

        {phase === "done" ? (
          <div className="p-6 flex-1 flex flex-col items-center justify-center text-center gap-3">
            <div className="text-4xl">✅</div>
            <div className="font-semibold">Merci, votre ticket a été transmis.</div>
            <p className="text-sm text-slate-500">
              L'équipe va l'examiner. Vous pouvez fermer cette fenêtre.
            </p>
            <button
              onClick={onClose}
              className="mt-2 px-4 py-2 rounded-md bg-aubergine-700 text-white text-sm"
            >
              Fermer
            </button>
          </div>
        ) : phase === "chat" ? (
          <>
            <div ref={scrollRef} className="p-5 space-y-3 overflow-y-auto flex-1">
              {thread.map((m, i) => (
                <div
                  key={i}
                  className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
                >
                  <div
                    className={
                      "max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words " +
                      (m.role === "user"
                        ? "bg-aubergine-700 text-white rounded-br-sm"
                        : "bg-slate-100 text-slate-800 rounded-bl-sm")
                    }
                  >
                    {m.content}
                  </div>
                </div>
              ))}
              {busy && (
                <div className="flex justify-start">
                  <div
                    role="status"
                    aria-label="L'assistant réfléchit"
                    className="bg-slate-100 rounded-2xl rounded-bl-sm px-3 py-2 flex items-center gap-2"
                  >
                    <span className="flex gap-1" aria-hidden="true">
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
                        style={{ animationDelay: "0ms" }}
                      />
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
                        style={{ animationDelay: "150ms" }}
                      />
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
                        style={{ animationDelay: "300ms" }}
                      />
                    </span>
                    <span className="text-sm text-slate-500">L'assistant réfléchit…</span>
                  </div>
                </div>
              )}
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>

            <div className="p-3 border-t border-slate-200 flex items-end gap-2">
              <textarea
                autoFocus
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="Votre réponse… (Entrée pour envoyer)"
                className="flex-1 border border-slate-300 rounded-md px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-aubergine-400"
              />
              <button
                onClick={send}
                disabled={busy || !input.trim()}
                className="px-4 py-2 rounded-md bg-aubergine-700 text-white text-sm disabled:opacity-50"
              >
                Envoyer
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="p-5 space-y-4 overflow-y-auto">
              {/* Issue #118 : expliciter le fonctionnement de l'outil pour que
                  l'utilisateur sache, avant d'envoyer, qu'un agent IA traite
                  d'abord sa demande puis la remonte au support pour validation. */}
              <p className="text-[12px] leading-relaxed text-slate-600 bg-slate-50 border border-slate-200 rounded-md p-3">
                <span aria-hidden="true">💡 </span>
                Après «&nbsp;Démarrer&nbsp;», un assistant IA échange avec vous pour
                préciser votre demande puis crée le ticket. Celui-ci est ensuite
                transmis à l'équipe de support, qui le valide avant traitement.
              </p>

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

              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={onPickFiles}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={files.length >= MAX_ATTACHMENTS}
                  className="px-2.5 py-1.5 rounded border border-slate-300 hover:bg-slate-50 text-sm disabled:opacity-50"
                >
                  <span aria-hidden="true">📎 </span>Joindre une capture
                </button>
                <span className="block text-[12px] text-slate-500 mt-1">
                  Images uniquement · {MAX_ATTACHMENTS} max · 5 Mo chacune.
                </span>
                {files.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {files.map((f, i) => (
                      <li
                        key={`${f.name}-${f.size}-${i}`}
                        className="flex items-center justify-between gap-2 text-[12px] bg-slate-50 border border-slate-200 rounded px-2 py-1"
                      >
                        <span className="truncate min-w-0">{f.name}</span>
                        <button
                          type="button"
                          onClick={() => removeFile(i)}
                          aria-label={`Retirer ${f.name}`}
                          className="shrink-0 text-slate-400 hover:text-red-600"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

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
                onClick={start}
                disabled={busy || !message.trim()}
                className="px-4 py-1.5 rounded-md bg-aubergine-700 text-white text-sm disabled:opacity-50"
              >
                {busy ? "Envoi…" : "Démarrer"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
