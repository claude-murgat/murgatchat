import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import EmojiPicker from "emoji-picker-react";
import GifPicker from "./GifPicker.jsx";
import { uploadFile, api } from "../api.js";

function formatLocalIso(dt) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

function Composer({ onSend, placeholder, allowSchedule = true, onTyping }, ref) {
  const [text, setText] = useState("");
  const [showSchedule, setShowSchedule] = useState(false);
  const defaultSched = new Date(Date.now() + 60 * 60_000);
  const [scheduledAt, setScheduledAt] = useState(formatLocalIso(defaultSched));
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const emojiRef = useRef(null);
  const emojiBtnRef = useRef(null);
  const [showGif, setShowGif] = useState(false);
  const [gifBusy, setGifBusy] = useState(false);
  const gifRef = useRef(null);
  const gifBtnRef = useRef(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }, [text]);

  useEffect(() => {
    if (!showEmoji) return;
    function onDocMouseDown(e) {
      if (emojiRef.current?.contains(e.target)) return;
      if (emojiBtnRef.current?.contains(e.target)) return;
      setShowEmoji(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [showEmoji]);

  useEffect(() => {
    if (!showGif) return;
    function onDocMouseDown(e) {
      if (gifRef.current?.contains(e.target)) return;
      if (gifBtnRef.current?.contains(e.target)) return;
      setShowGif(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [showGif]);

  // Picking a GIF imports it (re-hosted, encrypted) and sends it straight away as
  // its own message — the typical GIF UX, and it leaves any in-progress text alone.
  async function onGifSelect(gif) {
    setShowGif(false);
    setGifBusy(true);
    try {
      // importGif resolves to { attachment: { id, … } } — send the attachment id,
      // not the wrapper object (sending `undefined` made the server 500).
      const { attachment } = await api.importGif(gif.fullUrl);
      onSend({ body: "", attachmentIds: [attachment.id] });
    } catch (err) {
      alert(err?.message || "Échec de l'envoi du GIF");
    } finally {
      setGifBusy(false);
    }
  }

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

  // La zone de chat (ChannelView) gère le glisser-déposer et nous transmet les
  // fichiers déposés via cette ref, afin que tout l'upload reste centralisé ici.
  useImperativeHandle(ref, () => ({ ingestFiles }));

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
    <div className="relative border border-slate-300 rounded-lg bg-white shadow-sm">
      {showEmoji && (
        <div
          ref={emojiRef}
          className="absolute bottom-full left-2 mb-2 z-50 shadow-xl rounded"
        >
          <EmojiPicker
            onEmojiClick={(e) => {
              setText((t) => t + e.emoji);
              setShowEmoji(false);
            }}
            width={300}
            height={380}
            previewConfig={{ showPreview: false }}
            lazyLoadEmojis
          />
        </div>
      )}
      {showGif && (
        <div ref={gifRef} className="absolute bottom-full left-2 mb-2 z-50">
          <GifPicker onSelect={onGifSelect} />
        </div>
      )}
      <textarea
        ref={taRef}
        rows={1}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onTyping?.();
        }}
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
          <button
            ref={emojiBtnRef}
            onClick={() => setShowEmoji((v) => !v)}
            className="text-slate-500 hover:text-slate-800 px-2 py-1 text-base leading-none"
            title="Emoji"
          >
            😀
          </button>
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
            {/* Mascotte « Clippy » en SVG inline plutôt que l'emoji 📎 :
                l'emoji ne s'affiche pas sur toutes les plateformes (Linux/Chrome
                sans police emoji couleur le rend en « tofu »), rendant le bouton
                invisible pour certains utilisateurs (cf. #102). Le SVG s'affiche
                partout, à l'identique du bouton « Planifier » voisin.
                Issue #98 puis #113 : on dessine une vraie mascotte Clippy et non
                un trombone générique. Pour être reconnaissable, on reprend les
                traits emblématiques du personnage Microsoft (sans réutiliser
                l'asset officiel, soumis à droits) :
                  - la silhouette iconique du trombone (fil extérieur replié +
                    fil intérieur imbriqué), pas un simple fil unique « feather » ;
                  - de gros yeux globuleux (contour + pupille) ;
                  - les sourcils expressifs, signature qui le distingue d'un
                    trombone ordinaire.
                Les <circle> forment les yeux (attendus par le test e2e). */}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {/* Corps : fil extérieur replié (boucle haute + boucle basse) puis
                  fil intérieur redescendant, soit la forme classique d'un trombone. */}
              <path d="M14.5 9 v8 a3 3 0 0 1 -6 0 V8.5 a3 3 0 0 1 6 0 v7" />
              {/* Yeux globuleux de Clippy (contour + pupille). */}
              <circle cx="10.4" cy="7.2" r="1.7" strokeWidth="1.3" />
              <circle cx="13.6" cy="7.2" r="1.7" strokeWidth="1.3" />
              <circle cx="10.7" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
              <circle cx="13.3" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
              {/* Sourcils expressifs, la marque de fabrique de Clippy. */}
              <path d="M8.6 4.3 11 5" strokeWidth="1.4" />
              <path d="M15.4 4.3 13 5" strokeWidth="1.4" />
            </svg>
            {uploading ? "Envoi..." : "Fichier"}
          </button>
          <button
            ref={gifBtnRef}
            onClick={() => setShowGif((v) => !v)}
            disabled={gifBusy}
            className="text-slate-500 hover:text-slate-800 px-2 py-1 text-sm font-bold tracking-wide disabled:opacity-50"
            title="Envoyer un GIF"
          >
            {gifBusy ? "…" : "GIF"}
          </button>
          {allowSchedule && (
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
          )}
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

export default forwardRef(Composer);
