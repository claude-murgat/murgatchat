import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import EmojiPicker from "emoji-picker-react";
import GifPicker from "./GifPicker.jsx";
import Avatar from "./Avatar.jsx";
import { uploadFile, api } from "../api.js";
import { emojiTokenAt, queryEmojiShortcodes } from "../emojiShortcodes.js";

function formatLocalIso(dt) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

// Détecte la mention en cours de saisie juste avant le curseur : on remonte
// jusqu'au "@" qui démarre le jeton (début de texte ou précédé d'une espace),
// sans espace ni saut de ligne entre ce "@" et le curseur. Renvoie
// { start, query } ou null s'il n'y a pas de mention active à cet endroit.
export function findMentionQuery(text, caret) {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (/\s/.test(ch)) return null;
    if (ch === "@") {
      if (i === 0 || /\s/.test(text[i - 1])) {
        return { start: i, query: text.slice(i + 1, caret) };
      }
      return null;
    }
  }
  return null;
}

// Candidats à proposer pour la mention « @query » : les autres membres du salon
// dont le username ou le nom affiché contient la requête (insensible à la casse).
// Limité à 8 entrées pour garder la liste lisible.
export function matchMembers(members, currentUser, query) {
  const q = query.toLowerCase();
  return (members || [])
    .filter((m) => m.id !== currentUser?.id)
    .filter(
      (m) =>
        !q ||
        m.username?.toLowerCase().includes(q) ||
        m.displayName?.toLowerCase().includes(q)
    )
    .slice(0, 8);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

// Sur les appareils tactiles (mobile/PWA), le pointeur est « coarse » : le clavier
// logiciel n'offre pas de raccourci pratique au saut de ligne, donc « Entrée » doit
// revenir à la ligne et l'envoi passe par le bouton « Envoyer » dédié (cf. #133).
// Sur desktop (pointeur fin), on garde Entrée = envoi (Maj+Entrée = saut de ligne).
function isTouchDevice() {
  return typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)")?.matches;
}

function Composer(
  {
    onSend,
    placeholder,
    allowSchedule = true,
    onTyping,
    members = [],
    currentUser,
    // Brouillon restauré pour CETTE conversation (texte + pièces jointes déjà
    // uploadées) + rappel pour le remonter au parent — voir #165.
    initialDraft,
    onDraftChange,
  },
  ref
) {
  const [text, setText] = useState(() => initialDraft?.text ?? "");
  // Autocomplétion de mention « @pseudo » (#135) : `mention` porte le jeton en
  // cours { start, query } ou null ; `mentionIndex` est l'entrée surlignée.
  const [mention, setMention] = useState(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [showSchedule, setShowSchedule] = useState(false);
  const defaultSched = new Date(Date.now() + 60 * 60_000);
  const [scheduledAt, setScheduledAt] = useState(formatLocalIso(defaultSched));
  const [attachments, setAttachments] = useState(() => initialDraft?.attachments ?? []);
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
  // Autocomplétion d'emojis « :nom » (issue #138). emojiQuery vaut null quand le
  // menu est fermé ; emojiItems liste les suggestions courantes ; emojiTokenStart
  // mémorise la position du « : » pour remplacer le bon segment à l'insertion.
  const [emojiQuery, setEmojiQuery] = useState(null);
  const [emojiItems, setEmojiItems] = useState([]);
  const [emojiIndex, setEmojiIndex] = useState(0);
  const emojiTokenStart = useRef(0);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }, [text]);

  // Remonte le brouillon courant (texte + pièces jointes) au parent à chaque
  // changement, pour qu'il soit conservé en quittant la conversation puis
  // restauré au retour (#165). Le callback est lu via un ref pour qu'un simple
  // changement de son identité ne redéclenche pas la synchro.
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  useEffect(() => {
    onDraftChangeRef.current?.({ text, attachments });
  }, [text, attachments]);

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

  function closeEmojiMenu() {
    setEmojiQuery(null);
    setEmojiItems([]);
  }

  // Recalcule le menu d'autocomplétion à partir du texte et de la position du
  // curseur. On n'ouvre qu'à partir de 2 caractères saisis après le « : » pour
  // ne pas inonder l'utilisateur dès la frappe d'un simple deux-points.
  function refreshEmojiMenu(value, caret) {
    const tok = emojiTokenAt(value, caret);
    if (!tok || tok.query.length < 2) {
      closeEmojiMenu();
      return;
    }
    const items = queryEmojiShortcodes(tok.query);
    if (items.length === 0) {
      closeEmojiMenu();
      return;
    }
    emojiTokenStart.current = tok.start;
    setEmojiItems(items);
    setEmojiQuery(tok.query);
    setEmojiIndex(0);
  }

  // Remplace le segment « :nom » en cours par le caractère emoji choisi.
  function applyEmojiSuggestion(item) {
    const ta = taRef.current;
    const caret = ta ? ta.selectionStart : text.length;
    const start = emojiTokenStart.current;
    const before = text.slice(0, start);
    const after = text.slice(caret);
    const insert = item.char + " ";
    setText(before + insert + after);
    closeEmojiMenu();
    const pos = before.length + insert.length;
    requestAnimationFrame(() => {
      if (ta) {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
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
    closeEmojiMenu();
  }

  // Recalcule le jeton de mention actif d'après le contenu et la position du
  // curseur ; remet la sélection au premier candidat à chaque changement.
  function refreshMention(value, caret) {
    setMention(findMentionQuery(value, caret));
    setMentionIndex(0);
  }

  // Remplace le « @query » en cours par « @username » (suivi d'une espace) afin
  // de coller à la convention reconnue côté serveur (isMentioned), puis replace
  // le curseur juste après la mention insérée.
  function applyMention(member) {
    if (!mention || !member) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.start + 1 + mention.query.length);
    const insert = `@${member.username} `;
    setText(before + insert + after);
    setMention(null);
    const caret = before.length + insert.length;
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(caret, caret);
      }
    });
  }

  function onKeyDown(e) {
    // Quand un menu d'autocomplétion est ouvert (emoji « :nom » #138, puis mention
    // « @ » #135), les flèches/Entrée/Tab/Échap le pilotent (et n'envoient pas).
    if (emojiQuery !== null && emojiItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setEmojiIndex((i) => (i + 1) % emojiItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setEmojiIndex((i) => (i - 1 + emojiItems.length) % emojiItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyEmojiSuggestion(emojiItems[emojiIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeEmojiMenu();
        return;
      }
    }
    if (showMentions) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex(
          (i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyMention(mentionCandidates[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    // Sur tactile, on laisse le comportement par défaut du textarea (saut de
    // ligne) : l'envoi se fait via le bouton « Envoyer » (cf. #133).
    if (e.key === "Enter" && !e.shiftKey && !isTouchDevice()) {
      e.preventDefault();
      send(false);
    }
  }

  const mentionCandidates = mention
    ? matchMembers(members, currentUser, mention.query)
    : [];
  const showMentions = mentionCandidates.length > 0;

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
      {emojiQuery !== null && emojiItems.length > 0 && (
        <div
          className="absolute bottom-full left-2 mb-2 z-50 w-64 max-h-60 overflow-auto bg-white border border-slate-200 rounded-lg shadow-xl py-1"
          role="listbox"
        >
          {emojiItems.map((it, i) => (
            <button
              key={it.name}
              type="button"
              role="option"
              aria-selected={i === emojiIndex}
              // onMouseDown + preventDefault : on insère sans que le textarea
              // perde le focus ni que le curseur bouge avant la lecture.
              onMouseDown={(e) => {
                e.preventDefault();
                applyEmojiSuggestion(it);
              }}
              onMouseEnter={() => setEmojiIndex(i)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                i === emojiIndex ? "bg-slate-100" : ""
              }`}
            >
              <span className="text-base leading-none">{it.char}</span>
              <span className="text-slate-600">:{it.name}:</span>
            </button>
          ))}
        </div>
      )}
      {showMentions && (
        <div className="absolute bottom-full left-2 mb-2 z-50 w-64 max-h-56 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl py-1">
          {mentionCandidates.map((m, i) => (
            <button
              key={m.id}
              type="button"
              // onMouseDown (et non onClick) + preventDefault : on insère la
              // mention sans laisser le textarea perdre le focus au préalable.
              onMouseDown={(e) => {
                e.preventDefault();
                applyMention(m);
              }}
              onMouseEnter={() => setMentionIndex(i)}
              className={`w-full text-left px-2 py-1.5 flex items-center gap-2 ${
                i === mentionIndex ? "bg-aubergine-700/10" : "hover:bg-slate-50"
              }`}
            >
              <Avatar user={m} size={28} />
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-slate-900 truncate">
                  {m.displayName}
                </span>
                <span className="block text-xs text-slate-500 truncate">
                  @{m.username}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        rows={1}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          refreshMention(e.target.value, e.target.selectionStart);
          onTyping?.();
          refreshEmojiMenu(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        // Ferme la liste de mentions quand on quitte le champ. La sélection à la
        // souris passe par onMouseDown+preventDefault, donc le blur n'y survient pas.
        onBlur={() => setMention(null)}
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
