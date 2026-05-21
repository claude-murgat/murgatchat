import { useState, useRef, useEffect } from "react";
import { uploadFile } from "../api.js";

function formatLocalIso(dt) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

export default function Composer({ onSend, placeholder }) {
  const [text, setText] = useState("");
  const [showSchedule, setShowSchedule] = useState(false);
  const defaultSched = new Date(Date.now() + 60 * 60_000);
  const [scheduledAt, setScheduledAt] = useState(formatLocalIso(defaultSched));
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const taRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }, [text]);

  async function ingestFiles(files) {
    if (!files.length) return;
    setUploading(true);
    try {
      for (const f of files) {
        const att = await uploadFile(f);
        setAttachments((prev) => [...prev, att]);
      }
    } catch (err) {
      alert(err.message || "Upload échoué");
    } finally {
      setUploading(false);
    }
  }

  async function onFilesPicked(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    await ingestFiles(files);
  }

  async function onPaste(e) {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (files.length === 0) return;
    e.preventDefault();
    await ingestFiles(files);
  }

  function removeAttachment(id) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function send(schedule = false) {
    const body = text.trim();
    if (!body && attachments.length === 0) return;
    const payload = { body, attachmentIds: attachments.map((a) => a.id) };
    if (schedule) {
      const d = new Date(scheduledAt);
      if (isNaN(d.getTime()) || d.getTime() <= Date.now() + 1000) {
        alert("Choisissez une date dans le futur.");
        return;
      }
      payload.scheduledAt = d.toISOString();
    }
    onSend(payload);
    setText("");
    setAttachments([]);
    setShowSchedule(false);
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(false);
    }
  }

  return (
    <div className="border border-slate-300 rounded-lg bg-white shadow-sm">
      <textarea
        ref={taRef}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={placeholder || "Écrire un message..."}
        className="w-full resize-none px-3 py-3 text-slate-900 outline-none rounded-t-lg"
      />
      {attachments.length > 0 && (
        <div className="px-3 py-2 border-t border-slate-200 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-2 bg-slate-100 rounded px-2 py-1 text-sm text-slate-700"
            >
              <span>📎</span>
              <span className="max-w-[160px] truncate">{a.filename}</span>
              <span className="text-slate-400 text-xs">{fmtBytes(a.size)}</span>
              <button
                onClick={() => removeAttachment(a.id)}
                className="text-slate-500 hover:text-red-600"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {showSchedule && (
        <div className="px-3 py-2 border-t border-slate-200 bg-slate-50 flex items-center gap-2 text-slate-800 text-sm">
          <span>Envoyer le</span>
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            className="border border-slate-300 rounded px-2 py-1"
          />
          <button
            onClick={() => send(true)}
            className="ml-auto bg-slackgreen text-white px-3 py-1 rounded font-medium hover:opacity-90"
          >
            Planifier
          </button>
        </div>
      )}
      <div className="flex items-center justify-between px-2 py-1 border-t border-slate-200">
        <div className="flex items-center gap-1">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={onFilesPicked}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="text-slate-500 hover:text-slate-800 px-2 py-1 text-sm flex items-center gap-1 disabled:opacity-50"
            title="Joindre un fichier"
          >
            <span>📎</span>
            {uploading ? "Envoi..." : "Fichier"}
          </button>
          <button
            onClick={() => setShowSchedule((v) => !v)}
            className="text-slate-500 hover:text-slate-800 px-2 py-1 text-sm flex items-center gap-1"
            title="Planifier un envoi"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
            Planifier
          </button>
        </div>
        <button
          onClick={() => send(false)}
          disabled={(!text.trim() && attachments.length === 0) || uploading}
          className="bg-slackgreen text-white px-3 py-1.5 rounded font-medium hover:opacity-90 disabled:opacity-40"
        >
          Envoyer
        </button>
      </div>
    </div>
  );
}
