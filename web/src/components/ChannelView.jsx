import { useEffect, useRef, useState } from "react";
import EmojiPicker from "emoji-picker-react";
import Avatar from "./Avatar.jsx";
import Composer from "./Composer.jsx";
import MessageMarkdown from "./MessageMarkdown.jsx";
import AttachmentModal from "./AttachmentModal.jsx";
import ForwardMessageModal from "./ForwardMessageModal.jsx";
import { api, attachmentUrl } from "../api.js";
import { isWindowFocused } from "../desktop.js";

function fmtBytes(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

function Attachments({ attachments }) {
  // Clicking an attachment opens an in-app preview modal (with a download button)
  // instead of navigating to the raw server URL in a new tab.
  const [selected, setSelected] = useState(null);
  if (!attachments?.length) return null;
  return (
    <>
      <div className="mt-1 flex flex-wrap gap-2">
        {attachments.map((a) => {
          const isImg = a.mimeType?.startsWith("image/");
          if (isImg) {
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => setSelected(a)}
                className="block rounded overflow-hidden focus:outline-none focus:ring-2 focus:ring-aubergine-400"
              >
                <img
                  src={attachmentUrl(a.id)}
                  alt={a.filename}
                  className="max-h-56 max-w-xs rounded border border-slate-200 object-cover"
                />
              </button>
            );
          }
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => setSelected(a)}
              className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 rounded px-2 py-1.5 text-sm text-slate-800 max-w-xs text-left"
            >
              <span className="text-lg">📄</span>
              <span className="flex-1 truncate">{a.filename}</span>
              <span className="text-slate-500 text-xs">{fmtBytes(a.size)}</span>
            </button>
          );
        })}
      </div>
      {selected && (
        <AttachmentModal attachment={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

function formatDate(d) {
  const date = new Date(d);
  return date.toLocaleString([], { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(d) {
  const date = new Date(d);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const same = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (same(date, today)) return "Aujourd'hui";
  if (same(date, yesterday)) return "Hier";
  return date.toLocaleDateString();
}

function typingLabel(userIds, channel, currentUser) {
  const names = userIds
    .filter((id) => id !== currentUser?.id)
    .map(
      (id) =>
        channel.members?.find((m) => m.id === id)?.displayName || "Quelqu'un"
    );
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} est en train d'écrire`;
  if (names.length === 2) return `${names[0]} et ${names[1]} écrivent`;
  return "Plusieurs personnes écrivent";
}

function reactionLabel(users) {
  const names = (users || []).map((u) => u.displayName || "Quelqu'un");
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} a réagi`;
  if (names.length === 2) return `${names[0]} et ${names[1]} ont réagi`;
  const others = names.length - 2;
  return `${names[0]}, ${names[1]} et ${others} autre${others > 1 ? "s" : ""} ont réagi`;
}

function previewSnippet(body, max = 60) {
  const flat = (body || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

// Niveaux de notification par channel exposés dans le menu du header.
const NOTIFY_OPTIONS = [
  { value: "all", icon: "🔔", label: "Tout", hint: "Notifier chaque message" },
  { value: "mentions", icon: "💬", label: "Mentions", hint: "Seulement quand je suis cité" },
  { value: "none", icon: "🔕", label: "Muet", hint: "Aucune notification" },
];

// Corps d'un message transféré (#124) : une ligne d'attribution + le texte
// d'origine cité en bloc markdown (chaque ligne préfixée par « > » pour rester
// dans la citation). Les pièces jointes ne sont pas reportées (elles sont liées
// au message d'origine côté serveur) — seul le texte est transféré.
function buildForwardBody(message) {
  const author = message.author?.displayName || "?";
  const quoted = (message.body || "")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `**↪ Message transféré de ${author} :**\n${quoted}`;
}

export default function ChannelView({
  channel,
  currentUser,
  socket,
  onlineUserIds,
  onAddMembers,
  onShowMembers,
  // Persiste le niveau de notification choisi pour ce channel (remonte à App.jsx).
  onNotifyLevelChange,
  // Liste complète des conversations + bascule, pour le transfert de message (#124).
  channels = [],
  onSwitchChannel,
  // Mobile-only : retour à la liste des canaux (annule activeChannelId dans App.jsx).
  // Sur desktop (md+), le bouton est masqué et la sidebar reste à gauche en permanence.
  onBackToList,
}) {
  const [messages, setMessages] = useState([]);
  const [scheduled, setScheduled] = useState([]);
  const [showScheduled, setShowScheduled] = useState(false);
  // Discord-style: tapping "Répondre" sets the target here; the next outgoing
  // message gets `parentId` and clears it. No more side panel.
  const [replyingTo, setReplyingTo] = useState(null);
  // Message en cours de transfert vers une autre conversation (#124). Ouvre la
  // modale de sélection de destination ; null = modale fermée.
  const [forwardingMessage, setForwardingMessage] = useState(null);
  const [typingUserIds, setTypingUserIds] = useState([]);
  const [showNotifyMenu, setShowNotifyMenu] = useState(false);
  const notifyMenuRef = useRef(null);
  const scrollRef = useRef(null);
  const messageRefs = useRef({});
  const typingTimers = useRef({});
  const lastTypingSent = useRef(0);
  // Glisser-déposer de fichiers sur la zone de chat. Le compteur gère les
  // événements dragenter/dragleave qui se déclenchent aussi sur les enfants :
  // on n'éteint l'overlay que lorsqu'il revient à zéro (on a vraiment quitté
  // la zone). L'upload lui-même est délégué au Composer via cette ref.
  const composerRef = useRef(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  function isFileDrag(e) {
    return Array.from(e.dataTransfer?.types || []).includes("Files");
  }

  function onDragEnter(e) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragOver(e) {
    if (!isFileDrag(e)) return;
    // Indispensable pour autoriser le drop (sinon le navigateur ouvre le fichier).
    e.preventDefault();
  }

  function onDragLeave(e) {
    if (!isFileDrag(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDrop(e) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) composerRef.current?.ingestFiles(files);
  }

  // Scroll to a message (clicked from a quote bubble) and flash it for 1.5 s.
  function jumpToMessage(id) {
    const el = messageRefs.current[id];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-amber-400");
    setTimeout(() => el.classList.remove("ring-2", "ring-amber-400"), 1500);
  }

  useEffect(() => {
    if (!channel) return;
    let cancelled = false;
    setTypingUserIds([]);
    setReplyingTo(null);
    api.messages(channel.id).then((res) => {
      if (!cancelled) setMessages(res.messages);
    });
    api.scheduled(channel.id).then((res) => {
      if (!cancelled) setScheduled(res.scheduled);
    });
    socket?.emit("channel:join", channel.id);
    if (isWindowFocused()) socket?.emit("channel:read", { channelId: channel.id });
    return () => {
      cancelled = true;
    };
  }, [channel?.id, socket]);

  useEffect(() => {
    if (!channel || !socket) return;
    const markRead = () => {
      if (isWindowFocused()) socket.emit("channel:read", { channelId: channel.id });
    };
    window.addEventListener("focus", markRead);
    document.addEventListener("visibilitychange", markRead);
    return () => {
      window.removeEventListener("focus", markRead);
      document.removeEventListener("visibilitychange", markRead);
    };
  }, [channel?.id, socket]);

  useEffect(() => {
    if (!socket) return;
    function onNew(msg) {
      if (!channel || msg.channelId !== channel.id) return;
      // Replies arrive on `message:new` too in the new model (parent quote is
      // carried inline in `msg.parent`), so a single handler covers both.
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      if (isWindowFocused()) socket.emit("channel:read", { channelId: channel.id });
    }
    function onUpdated(msg) {
      if (!channel || msg.channelId !== channel.id) return;
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
    }
    function onDeleted({ id, channelId }) {
      if (!channel || channelId !== channel.id) return;
      setMessages((prev) => prev.filter((m) => m.id !== id));
      // Don't keep an orphaned reply-target if it just vanished.
      setReplyingTo((curr) => (curr?.id === id ? null : curr));
    }
    function onReaction({ messageId, reactions }) {
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, reactions } : m))
      );
    }
    function onTyping({ channelId, userId }) {
      if (!channel || channelId !== channel.id || userId === currentUser?.id) return;
      setTypingUserIds((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
      clearTimeout(typingTimers.current[userId]);
      typingTimers.current[userId] = setTimeout(() => {
        setTypingUserIds((prev) => prev.filter((id) => id !== userId));
        delete typingTimers.current[userId];
      }, 4000);
    }
    socket.on("message:new", onNew);
    socket.on("message:updated", onUpdated);
    socket.on("message:deleted", onDeleted);
    socket.on("reaction:update", onReaction);
    socket.on("typing:update", onTyping);
    return () => {
      socket.off("message:new", onNew);
      socket.off("message:updated", onUpdated);
      socket.off("message:deleted", onDeleted);
      socket.off("reaction:update", onReaction);
      socket.off("typing:update", onTyping);
    };
  }, [socket, channel?.id, currentUser?.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, channel?.id]);

  // Ferme le menu de notifications au clic en dehors / changement de channel.
  useEffect(() => {
    if (!showNotifyMenu) return;
    function onDocMouseDown(e) {
      if (!notifyMenuRef.current?.contains(e.target)) setShowNotifyMenu(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [showNotifyMenu]);

  useEffect(() => {
    setShowNotifyMenu(false);
  }, [channel?.id]);

  async function changeNotifyLevel(level) {
    setShowNotifyMenu(false);
    if (!channel || level === (channel.notifyLevel || "all")) return;
    try {
      await api.setChannelNotifyLevel(channel.id, level);
      onNotifyLevelChange?.(channel.id, level);
    } catch (e) {
      alert(e.message);
    }
  }

  function send(payload) {
    if (!channel || !socket) return;
    const parentId = replyingTo?.id || null;
    socket.emit(
      "message:send",
      { channelId: channel.id, parentId, ...payload },
      (resp) => {
        if (resp?.error) return alert(resp.error);
        if (resp?.scheduled) {
          setScheduled((prev) => [...prev, resp.scheduled]);
        }
      }
    );
    // Always release the reply target on send — Discord-style: one reply, one quote.
    setReplyingTo(null);
  }

  // Transfert (#124) : on renvoie le contenu du message dans la conversation
  // cible via le même `message:send` que l'envoi normal, puis on bascule dessus
  // pour que l'utilisateur voie le résultat.
  function forwardMessage(targetChannel) {
    if (!socket || !targetChannel || !forwardingMessage) return;
    const body = buildForwardBody(forwardingMessage);
    socket.emit(
      "message:send",
      { channelId: targetChannel.id, body },
      (resp) => {
        if (resp?.error) return alert(resp.error);
        setForwardingMessage(null);
        onSwitchChannel?.(targetChannel);
      }
    );
  }

  function notifyTyping() {
    if (!channel || !socket) return;
    const now = Date.now();
    if (now - lastTypingSent.current < 2000) return;
    lastTypingSent.current = now;
    socket.emit("typing", { channelId: channel.id });
  }

  async function cancelScheduled(id) {
    await api.deleteScheduled(id);
    setScheduled((prev) => prev.filter((m) => m.id !== id));
  }

  async function updateScheduled(id, body) {
    try {
      const res = await api.updateScheduled(id, body);
      setScheduled((prev) => prev.map((m) => (m.id === id ? res.scheduled : m)));
      return true;
    } catch (e) {
      alert(e.message);
      return false;
    }
  }

  async function editMessage(id, body) {
    try {
      const res = await api.editMessage(id, body);
      setMessages((prev) => prev.map((m) => (m.id === id ? res.message : m)));
      return true;
    } catch (e) {
      alert(e.message);
      return false;
    }
  }

  async function deleteMessage(message) {
    if (!window.confirm("Supprimer ce message ?")) return;
    try {
      await api.deleteMessage(message.id);
      setMessages((prev) => prev.filter((m) => m.id !== message.id));
    } catch (e) {
      alert(e.message);
    }
  }

  async function reactToMessage(messageId, emoji) {
    try {
      await api.react(messageId, emoji);
    } catch (e) {
      alert(e.message);
    }
  }

  if (!channel) {
    return (
      <div className="flex-1 grid place-items-center text-slate-400 bg-white">
        Sélectionnez une conversation
      </div>
    );
  }

  const headerTitle = channel.isDirect ? channel.displayName : `# ${channel.name}`;
  const currentNotifyOption =
    NOTIFY_OPTIONS.find((o) => o.value === (channel.notifyLevel || "all")) ||
    NOTIFY_OPTIONS[0];
  const dmOther = channel.isDirect
    ? channel.members.find((m) => m.id !== currentUser?.id) || channel.members[0]
    : null;
  const dmOnline = dmOther && onlineUserIds?.has(dmOther.id);

  let lastDay = null;

  return (
    <section
      className="relative flex-1 flex flex-col bg-white text-slate-900 min-w-0 h-full"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-aubergine-700/10 backdrop-blur-sm pointer-events-none">
          <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-aubergine-700 bg-white/90 px-8 py-6 shadow-lg">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-aubergine-700" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <div className="text-lg font-semibold text-aubergine-700">Déposez ici pour envoyer</div>
          </div>
        </div>
      )}
      <header
        className="border-b border-slate-200 px-3 sm:px-4 py-2.5 flex items-center gap-2 sm:gap-3"
        style={{ paddingTop: "max(0.625rem, env(safe-area-inset-top))" }}
      >
        {/* Bouton retour : visible uniquement sur mobile (md:hidden). Ferme la conversation
            active dans App.jsx → la Sidebar reprend tout l'écran. Touch target 44×44 minimum
            (recommandation Apple HIG). */}
        {onBackToList && (
          <button
            type="button"
            onClick={onBackToList}
            className="md:hidden -ml-1 w-11 h-11 grid place-items-center rounded text-slate-600 hover:bg-slate-100"
            aria-label="Retour à la liste des conversations"
          >
            <svg viewBox="0 0 24 24" className="w-6 h-6" aria-hidden="true">
              <path
                fill="currentColor"
                d="M15.7 4.3a1 1 0 0 1 0 1.4L9.4 12l6.3 6.3a1 1 0 1 1-1.4 1.4l-7-7a1 1 0 0 1 0-1.4l7-7a1 1 0 0 1 1.4 0Z"
              />
            </svg>
          </button>
        )}
        <div className="flex-1 min-w-0">
          <div className="font-bold truncate">{headerTitle}</div>
          {channel.isDirect ? (
            channel.members.length > 2 ? (
              <div className="text-xs text-slate-500 truncate">
                Groupe · {channel.members.length} personnes
              </div>
            ) : (
              <div className="text-xs text-slate-500 flex items-center gap-1.5">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    dmOnline ? "bg-green-500" : "bg-slate-400"
                  }`}
                />
                <span className="truncate">{dmOnline ? "En ligne" : "Hors ligne"}</span>
              </div>
            )
          ) : (
            <div className="text-xs text-slate-500 truncate">
              <button onClick={onShowMembers} className="hover:underline">
                {channel.members.length} membre{channel.members.length > 1 ? "s" : ""}
              </button>
              {channel.description ? ` · ${channel.description}` : ""}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {!channel.isDirect && (
            <button
              onClick={onAddMembers}
              className="text-xs px-2 py-1.5 rounded border border-slate-300 hover:bg-slate-100 hidden sm:inline-block"
              title="Ajouter des membres"
            >
              + Membres
            </button>
          )}
          {/* Version compacte du bouton "+ Membres" sur mobile : icône seule. */}
          {!channel.isDirect && (
            <button
              onClick={onAddMembers}
              className="sm:hidden w-10 h-10 grid place-items-center rounded text-slate-600 hover:bg-slate-100"
              aria-label="Ajouter des membres"
            >
              <span className="text-xl leading-none">+</span>
            </button>
          )}
          <button
            onClick={() => setShowScheduled((v) => !v)}
            className={`text-xs px-2 py-1.5 rounded ${
              showScheduled ? "bg-aubergine-700 text-white" : "border border-slate-300"
            }`}
            title="Messages planifiés"
          >
            <span className="hidden sm:inline">Planifiés </span>
            <span aria-hidden="true">⏰</span>
            <span className="ml-1">({scheduled.length})</span>
          </button>
          <div className="relative" ref={notifyMenuRef}>
            <button
              onClick={() => setShowNotifyMenu((v) => !v)}
              className="w-10 h-10 sm:w-auto sm:h-auto sm:px-2 sm:py-1.5 grid place-items-center sm:inline-block text-xs rounded text-slate-600 hover:bg-slate-100 sm:border sm:border-slate-300"
              title={`Notifications : ${currentNotifyOption.label}`}
              aria-label={`Notifications du salon : ${currentNotifyOption.label}`}
            >
              <span aria-hidden="true">{currentNotifyOption.icon}</span>
            </button>
            {showNotifyMenu && (
              <div className="absolute right-0 top-full mt-1 z-50 w-60 rounded-lg border border-slate-200 bg-white shadow-xl py-1">
                <div className="px-3 py-1.5 text-xs font-semibold text-slate-500">
                  Notifications de ce salon
                </div>
                {NOTIFY_OPTIONS.map((opt) => {
                  const active = (channel.notifyLevel || "all") === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => changeNotifyLevel(opt.value)}
                      className={`w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-slate-50 ${
                        active ? "bg-aubergine-700/5" : ""
                      }`}
                    >
                      <span aria-hidden="true" className="text-base leading-5">{opt.icon}</span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm text-slate-900">{opt.label}</span>
                        <span className="block text-xs text-slate-500">{opt.hint}</span>
                      </span>
                      {active && <span className="text-aubergine-700" aria-hidden="true">✓</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </header>

      {showScheduled && (
        <div className="border-b border-slate-200 bg-amber-50 px-4 py-2 max-h-40 overflow-y-auto">
          {scheduled.length === 0 ? (
            <div className="text-sm text-slate-500">Aucun message planifié</div>
          ) : (
            scheduled.map((m) => (
              <ScheduledRow
                key={m.id}
                message={m}
                onCancel={() => cancelScheduled(m.id)}
                onSave={(payload) => updateScheduled(m.id, payload)}
              />
            ))
          )}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-4 py-3">
        {messages.map((m, idx) => {
          const day = dayLabel(m.createdAt);
          const showDay = day !== lastDay;
          lastDay = day;
          const prev = messages[idx - 1];
          // Replies break the grouping (visual separator on top of the quote
          // bubble), even if the same author posted just before.
          const groupWithPrev =
            !m.parent &&
            prev &&
            !prev.parent &&
            prev.author?.id === m.author?.id &&
            new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60_000 &&
            !showDay;
          return (
            <div key={m.id}>
              {showDay && (
                <div className="flex items-center my-3">
                  <div className="flex-1 border-t border-slate-200" />
                  <div className="px-3 text-xs text-slate-500">{day}</div>
                  <div className="flex-1 border-t border-slate-200" />
                </div>
              )}
              <MessageRow
                rowRef={(el) => {
                  if (el) messageRefs.current[m.id] = el;
                  else delete messageRefs.current[m.id];
                }}
                message={m}
                grouped={groupWithPrev}
                currentUser={currentUser}
                onEdit={editMessage}
                onDelete={deleteMessage}
                onReply={() => setReplyingTo(m)}
                onForward={() => setForwardingMessage(m)}
                onReact={reactToMessage}
                onJumpToParent={jumpToMessage}
              />
            </div>
          );
        })}
        {messages.length === 0 && (
          <div className="text-center text-slate-400 mt-12 text-sm">
            Premier message dans cette conversation.
          </div>
        )}
      </div>

      <div
        className="border-t border-slate-200 px-3 pt-1"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <div className="h-4 px-1 text-xs italic text-slate-500">
          {typingUserIds.length > 0 &&
            `${typingLabel(typingUserIds, channel, currentUser)}…`}
        </div>
        {replyingTo && (
          <div className="mb-1 flex items-center gap-2 px-2 py-1.5 rounded bg-aubergine-700/10 border border-aubergine-700/30 text-xs">
            <span className="text-aubergine-700 font-semibold">↩ Réponse à</span>
            <span className="font-medium text-slate-900">
              {replyingTo.author?.displayName || "?"}
            </span>
            <span className="flex-1 truncate text-slate-600">
              {previewSnippet(replyingTo.body, 90)}
            </span>
            <button
              type="button"
              onClick={() => setReplyingTo(null)}
              className="text-slate-500 hover:text-slate-900 px-1"
              title="Annuler la réponse"
            >
              ✕
            </button>
          </div>
        )}
        <Composer
          ref={composerRef}
          onSend={send}
          onTyping={notifyTyping}
          members={channel.members}
          currentUser={currentUser}
          placeholder={
            channel.isDirect
              ? `Message à ${channel.displayName}`
              : `Message dans #${channel.name}`
          }
        />
      </div>

      {forwardingMessage && (
        <ForwardMessageModal
          message={forwardingMessage}
          channels={channels}
          onClose={() => setForwardingMessage(null)}
          onPick={forwardMessage}
        />
      )}
    </section>
  );
}

function toLocalIso(value) {
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function ScheduledRow({ message, onCancel, onSave }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(message.body);
  const [when, setWhen] = useState(toLocalIso(message.scheduledAt));
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setBody(message.body);
    setWhen(toLocalIso(message.scheduledAt));
    setEditing(true);
  }

  async function save() {
    const payload = {};
    if (body.trim() && body.trim() !== message.body) payload.body = body.trim();
    const newDate = new Date(when);
    if (
      !isNaN(newDate.getTime()) &&
      newDate.getTime() !== new Date(message.scheduledAt).getTime()
    ) {
      payload.scheduledAt = newDate.toISOString();
    }
    if (Object.keys(payload).length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await onSave(payload);
    setSaving(false);
    if (ok) setEditing(false);
  }

  if (editing) {
    return (
      <div className="py-2 text-sm border-b border-amber-100 last:border-0 space-y-1">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          className="w-full border border-amber-300 rounded px-2 py-1 text-slate-900 resize-none"
        />
        <div className="flex items-center gap-2">
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className="border border-amber-300 rounded px-2 py-1"
          />
          <button
            onClick={save}
            disabled={saving || !body.trim()}
            className="bg-slackgreen text-white px-3 py-1 rounded font-medium disabled:opacity-50"
          >
            Enregistrer
          </button>
          <button
            onClick={() => setEditing(false)}
            className="text-slate-600 hover:underline"
          >
            Annuler
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 py-1 text-sm border-b border-amber-100 last:border-0">
      <span className="text-amber-700">⏰</span>
      <span className="font-medium whitespace-nowrap">
        {new Date(message.scheduledAt).toLocaleString()}
      </span>
      <span className="text-slate-700 truncate flex-1">{message.body}</span>
      <button onClick={startEdit} className="text-aubergine-700 hover:underline">
        Modifier
      </button>
      <button onClick={onCancel} className="text-red-600 hover:underline">
        Supprimer
      </button>
    </div>
  );
}

// Inline quote bubble for replies. Clicking it jumps to the original message.
// Native `title` provides the full-body tooltip on hover (the user asked for
// "infobulle + lien vers le message").
function QuoteBubble({ parent, onJump }) {
  if (!parent) return null;
  const label = parent.author?.displayName || "?";
  const snippet = previewSnippet(parent.body, 100);
  return (
    <button
      type="button"
      onClick={() => onJump?.(parent.id)}
      title={parent.body || ""}
      className="block w-full text-left mb-1 pl-2 border-l-2 border-aubergine-700/60 hover:border-aubergine-700 group/quote"
    >
      <div className="text-xs text-aubergine-700 font-semibold">↩ {label}</div>
      <div className="text-xs text-slate-600 truncate group-hover/quote:text-slate-900">
        {snippet || <em>(pièce jointe)</em>}
      </div>
    </button>
  );
}

function MessageRow({
  rowRef,
  message,
  grouped,
  currentUser,
  onEdit,
  onDelete,
  onReply,
  onForward,
  onReact,
  onJumpToParent,
}) {
  const isOwn = message.author?.id === currentUser?.id;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body || "");
  const [showPicker, setShowPicker] = useState(false);
  const pickerRef = useRef(null);
  const reactBtnRef = useRef(null);

  useEffect(() => {
    if (!showPicker) return;
    function onDocMouseDown(e) {
      if (pickerRef.current?.contains(e.target)) return;
      if (reactBtnRef.current?.contains(e.target)) return;
      setShowPicker(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [showPicker]);

  function startEdit() {
    setDraft(message.body || "");
    setEditing(true);
  }
  async function save() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (trimmed === message.body) {
      setEditing(false);
      return;
    }
    const ok = await onEdit(message.id, trimmed);
    if (ok) setEditing(false);
  }
  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditing(false);
    }
  }

  const body = editing ? (
    <div className="mt-0.5">
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        className="w-full border border-slate-300 rounded px-2 py-1 text-slate-900 resize-none outline-none focus:border-aubergine-700"
      />
      <div className="flex items-center gap-2 mt-1 text-xs">
        <button
          onClick={save}
          disabled={!draft.trim()}
          className="bg-slackgreen text-white px-2 py-1 rounded font-medium disabled:opacity-50"
        >
          Enregistrer
        </button>
        <button onClick={() => setEditing(false)} className="text-slate-600 hover:underline">
          Annuler
        </button>
        <span className="text-slate-400">Entrée pour enregistrer · Échap pour annuler</span>
      </div>
    </div>
  ) : (
    message.body && (
      <div className="text-slate-900 break-words">
        <MessageMarkdown>{message.body}</MessageMarkdown>
        {message.editedAt && (
          <span
            className="text-xs text-slate-400 ml-1"
            title={`Modifié le ${new Date(message.editedAt).toLocaleString()}`}
          >
            (modifié)
          </span>
        )}
      </div>
    )
  );

  // Le transfert ne reporte que le texte ; on masque l'action pour un message
  // sans corps (pièce jointe / GIF seul) qui n'aurait rien à transférer (#124).
  const canForward = onForward && !!message.body;
  const actions = !editing && (onReact || onReply || canForward || isOwn) && (
    <div className="absolute right-2 top-1 hidden group-hover:flex items-center gap-1 bg-white border border-slate-200 rounded shadow-sm">
      {onReact && (
        <button
          ref={reactBtnRef}
          onClick={() => setShowPicker((v) => !v)}
          className="text-xs text-slate-600 hover:text-aubergine-700 px-2 py-1"
          title="Réagir"
        >
          😀
        </button>
      )}
      {onReply && (
        <button
          onClick={() => onReply(message)}
          className="text-xs text-slate-600 hover:text-aubergine-700 px-2 py-1"
          title="Répondre"
        >
          Répondre
        </button>
      )}
      {canForward && (
        <button
          onClick={onForward}
          className="text-xs text-slate-600 hover:text-aubergine-700 px-2 py-1"
          title="Transférer vers une autre conversation"
        >
          Transférer
        </button>
      )}
      {isOwn && (
        <button
          onClick={startEdit}
          className="text-xs text-slate-600 hover:text-aubergine-700 px-2 py-1"
          title="Modifier"
        >
          Modifier
        </button>
      )}
      {isOwn && (
        <button
          onClick={() => onDelete(message)}
          className="text-xs text-slate-600 hover:text-red-600 px-2 py-1"
          title="Supprimer"
        >
          Supprimer
        </button>
      )}
    </div>
  );

  const picker = showPicker && onReact && (
    <div ref={pickerRef} className="absolute right-2 top-8 z-50 shadow-xl rounded">
      <EmojiPicker
        onEmojiClick={(e) => {
          onReact(message.id, e.emoji);
          setShowPicker(false);
        }}
        width={300}
        height={380}
        previewConfig={{ showPreview: false }}
        lazyLoadEmojis
      />
    </div>
  );

  const reactionChips = message.reactions?.length > 0 && (
    <div className="mt-1 flex flex-wrap gap-1">
      {message.reactions.map((r) => {
        const mine = r.users?.some((u) => u.id === currentUser?.id);
        return (
          <div key={r.emoji} className="relative group/chip">
            <button
              onClick={() => onReact?.(message.id, r.emoji)}
              className={`text-xs rounded-full border px-2 py-0.5 flex items-center gap-1 ${
                mine
                  ? "border-aubergine-700 bg-aubergine-700/10 text-aubergine-800"
                  : "border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700"
              }`}
            >
              <span>{r.emoji}</span>
              <span>{r.count}</span>
            </button>
            <div className="pointer-events-none absolute bottom-full left-0 z-50 mb-1 hidden whitespace-nowrap rounded-md bg-slate-800 px-2 py-1 text-xs text-white shadow-lg group-hover/chip:block">
              {reactionLabel(r.users)}
            </div>
          </div>
        );
      })}
    </div>
  );

  if (grouped) {
    return (
      <div ref={rowRef} className="relative pl-12 pr-4 py-0.5 hover:bg-slate-50 group rounded">
        {actions}
        {picker}
        <div className="flex items-start gap-2">
          <div className="text-xs text-slate-400 w-0 group-hover:w-10 overflow-hidden transition-all">
            {formatDate(message.createdAt)}
          </div>
          <div className="flex-1 min-w-0">
            {body}
            <Attachments attachments={message.attachments} />
            {reactionChips}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div ref={rowRef} className="relative px-2 py-1.5 hover:bg-slate-50 rounded group">
      {actions}
      {picker}
      <div className="flex items-start gap-2">
        <Avatar user={message.author} size={36} />
        <div className="flex-1 min-w-0">
          <QuoteBubble parent={message.parent} onJump={onJumpToParent} />
          <div className="flex items-baseline gap-2">
            <span className="font-bold">{message.author?.displayName}</span>
            <span className="text-xs text-slate-500">{formatDate(message.createdAt)}</span>
          </div>
          {body}
          <Attachments attachments={message.attachments} />
          {reactionChips}
        </div>
      </div>
    </div>
  );
}
