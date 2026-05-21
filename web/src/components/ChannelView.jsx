import { useEffect, useRef, useState } from "react";
import EmojiPicker from "emoji-picker-react";
import Avatar from "./Avatar.jsx";
import Composer from "./Composer.jsx";
import { api, attachmentUrl } from "../api.js";

function fmtBytes(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

function Attachments({ attachments }) {
  if (!attachments?.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {attachments.map((a) => {
        const isImg = a.mimeType?.startsWith("image/");
        const url = attachmentUrl(a.id);
        if (isImg) {
          return (
            <a
              key={a.id}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="block"
            >
              <img
                src={url}
                alt={a.filename}
                className="max-h-56 max-w-xs rounded border border-slate-200 object-cover"
              />
            </a>
          );
        }
        return (
          <a
            key={a.id}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 rounded px-2 py-1.5 text-sm text-slate-800 max-w-xs"
            download={a.filename}
          >
            <span className="text-lg">📄</span>
            <span className="flex-1 truncate">{a.filename}</span>
            <span className="text-slate-500 text-xs">{fmtBytes(a.size)}</span>
          </a>
        );
      })}
    </div>
  );
}

function formatDate(d) {
  const date = new Date(d);
  return date.toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
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

export default function ChannelView({ channel, currentUser, socket, onlineUserIds }) {
  const [messages, setMessages] = useState([]);
  const [scheduled, setScheduled] = useState([]);
  const [showScheduled, setShowScheduled] = useState(false);
  const [threadParentId, setThreadParentId] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!channel) return;
    let cancelled = false;
    api.messages(channel.id).then((res) => {
      if (!cancelled) setMessages(res.messages);
    });
    api.scheduled(channel.id).then((res) => {
      if (!cancelled) setScheduled(res.scheduled);
    });
    socket?.emit("channel:join", channel.id);
    socket?.emit("channel:read", { channelId: channel.id });
    return () => {
      cancelled = true;
    };
  }, [channel?.id, socket]);

  useEffect(() => {
    if (!socket) return;
    function onNew(msg) {
      if (!channel || msg.channelId !== channel.id) return;
      setMessages((prev) => [...prev, msg]);
      socket.emit("channel:read", { channelId: channel.id });
    }
    function onUpdated(msg) {
      if (!channel || msg.channelId !== channel.id) return;
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
    }
    function onDeleted({ id, channelId, parentId }) {
      if (!channel || channelId !== channel.id) return;
      if (parentId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === parentId
              ? { ...m, replyCount: Math.max(0, (m.replyCount || 0) - 1) }
              : m
          )
        );
      } else {
        setMessages((prev) => prev.filter((m) => m.id !== id));
      }
    }
    function onReply(msg) {
      if (!channel || msg.channelId !== channel.id) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.parentId
            ? { ...m, replyCount: (m.replyCount || 0) + 1 }
            : m
        )
      );
    }
    function onReaction({ messageId, reactions }) {
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, reactions } : m))
      );
    }
    socket.on("message:new", onNew);
    socket.on("message:updated", onUpdated);
    socket.on("message:deleted", onDeleted);
    socket.on("thread:reply", onReply);
    socket.on("reaction:update", onReaction);
    return () => {
      socket.off("message:new", onNew);
      socket.off("message:updated", onUpdated);
      socket.off("message:deleted", onDeleted);
      socket.off("thread:reply", onReply);
      socket.off("reaction:update", onReaction);
    };
  }, [socket, channel?.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, channel?.id]);

  function send(payload) {
    if (!channel || !socket) return;
    socket.emit(
      "message:send",
      { channelId: channel.id, ...payload },
      (resp) => {
        if (resp?.error) return alert(resp.error);
        if (resp?.scheduled) {
          setScheduled((prev) => [...prev, resp.scheduled]);
        }
      }
    );
  }

  function sendReply(payload) {
    if (!channel || !socket || !threadParentId) return;
    socket.emit(
      "message:send",
      { channelId: channel.id, parentId: threadParentId, ...payload },
      (resp) => {
        if (resp?.error) alert(resp.error);
      }
    );
  }

  const openThread = (message) => setThreadParentId(message.id);
  const closeThread = () => setThreadParentId(null);

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
      <div className="flex-1 grid place-items-center text-slate-400">
        Sélectionnez une conversation
      </div>
    );
  }

  const headerTitle = channel.isDirect
    ? channel.displayName
    : `# ${channel.name}`;
  const dmOther = channel.isDirect
    ? channel.members.find((m) => m.id !== currentUser?.id) || channel.members[0]
    : null;
  const dmOnline = dmOther && onlineUserIds?.has(dmOther.id);

  let lastDay = null;

  return (
    <div className="flex-1 flex min-w-0">
      <section className="flex-1 flex flex-col bg-white text-slate-900 min-w-0">
      <header className="border-b border-slate-200 px-4 py-2.5 flex items-center justify-between">
        <div>
          <div className="font-bold">{headerTitle}</div>
          {channel.isDirect ? (
            <div className="text-xs text-slate-500 flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  dmOnline ? "bg-green-500" : "bg-slate-400"
                }`}
              />
              {dmOnline ? "En ligne" : "Hors ligne"}
            </div>
          ) : (
            <div className="text-xs text-slate-500">
              {channel.members.length} membre{channel.members.length > 1 ? "s" : ""}
              {channel.description ? ` · ${channel.description}` : ""}
            </div>
          )}
        </div>
        <button
          onClick={() => setShowScheduled((v) => !v)}
          className={`text-xs px-2 py-1 rounded ${
            showScheduled ? "bg-aubergine-700 text-white" : "border border-slate-300"
          }`}
        >
          Planifiés ({scheduled.length})
        </button>
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
          const groupWithPrev =
            prev &&
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
                message={m}
                grouped={groupWithPrev}
                currentUser={currentUser}
                onEdit={editMessage}
                onDelete={deleteMessage}
                onReply={openThread}
                onReact={reactToMessage}
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

      <div className="p-3 border-t border-slate-200">
        <Composer
          onSend={send}
          placeholder={
            channel.isDirect
              ? `Message à ${channel.displayName}`
              : `Message dans #${channel.name}`
          }
        />
      </div>
      </section>
      {threadParentId && (
        <ThreadPanel
          parentId={threadParentId}
          currentUser={currentUser}
          socket={socket}
          onClose={closeThread}
          onSend={sendReply}
          onEdit={editMessage}
          onDelete={deleteMessage}
          onReact={reactToMessage}
        />
      )}
    </div>
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

function ThreadPanel({ parentId, currentUser, socket, onClose, onSend, onEdit, onDelete, onReact }) {
  const [parent, setParent] = useState(null);
  const [replies, setReplies] = useState([]);
  const scrollRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api.thread(parentId).then((res) => {
      if (cancelled) return;
      setParent(res.parent);
      setReplies(res.replies);
    });
    return () => {
      cancelled = true;
    };
  }, [parentId]);

  useEffect(() => {
    if (!socket) return;
    function onReply(msg) {
      if (msg.parentId !== parentId) return;
      setReplies((prev) => (prev.some((r) => r.id === msg.id) ? prev : [...prev, msg]));
    }
    function onUpdated(msg) {
      if (msg.id === parentId) return setParent(msg);
      if (msg.parentId !== parentId) return;
      setReplies((prev) => prev.map((r) => (r.id === msg.id ? msg : r)));
    }
    function onDeleted({ id, parentId: pid }) {
      if (id === parentId) return onClose();
      if (pid !== parentId) return;
      setReplies((prev) => prev.filter((r) => r.id !== id));
    }
    function onReaction({ messageId, reactions }) {
      setParent((p) => (p && p.id === messageId ? { ...p, reactions } : p));
      setReplies((prev) =>
        prev.map((r) => (r.id === messageId ? { ...r, reactions } : r))
      );
    }
    socket.on("thread:reply", onReply);
    socket.on("message:updated", onUpdated);
    socket.on("message:deleted", onDeleted);
    socket.on("reaction:update", onReaction);
    return () => {
      socket.off("thread:reply", onReply);
      socket.off("message:updated", onUpdated);
      socket.off("message:deleted", onDeleted);
      socket.off("reaction:update", onReaction);
    };
  }, [socket, parentId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [replies.length]);

  return (
    <aside className="w-96 border-l border-slate-200 flex flex-col bg-white">
      <header className="border-b border-slate-200 px-4 py-2.5 flex items-center justify-between">
        <div className="font-bold">Fil de discussion</div>
        <button
          onClick={onClose}
          className="text-slate-500 hover:text-slate-800 text-lg leading-none"
          title="Fermer"
        >
          ✕
        </button>
      </header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-3 py-3">
        {parent && (
          <div className="border-b border-slate-200 pb-2 mb-2">
            <MessageRow
              message={parent}
              grouped={false}
              currentUser={currentUser}
              onEdit={onEdit}
              onDelete={onDelete}
              onReact={onReact}
            />
          </div>
        )}
        {replies.map((r) => (
          <MessageRow
            key={r.id}
            message={r}
            grouped={false}
            currentUser={currentUser}
            onEdit={onEdit}
            onDelete={onDelete}
            onReact={onReact}
          />
        ))}
        {replies.length === 0 && (
          <div className="text-center text-slate-400 text-sm mt-6">
            Aucune réponse pour l'instant.
          </div>
        )}
      </div>
      <div className="p-3 border-t border-slate-200">
        <Composer onSend={onSend} placeholder="Répondre…" allowSchedule={false} />
      </div>
    </aside>
  );
}

function MessageRow({ message, grouped, currentUser, onEdit, onDelete, onReply, onReact }) {
  const isOwn = message.author?.id === currentUser?.id;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body || "");
  const [showPicker, setShowPicker] = useState(false);

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
      <div className="text-slate-900 whitespace-pre-wrap break-words">
        {message.body}
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

  const actions = !editing && (onReact || onReply || isOwn) && (
    <div className="absolute right-2 top-1 hidden group-hover:flex items-center gap-1 bg-white border border-slate-200 rounded shadow-sm">
      {onReact && (
        <button
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
          title="Répondre dans un fil"
        >
          Répondre
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
    <div className="absolute right-2 top-8 z-50 shadow-xl rounded">
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

  const footer = onReply && message.replyCount > 0 && (
    <button
      onClick={() => onReply(message)}
      className="mt-1 text-xs font-medium text-aubergine-700 hover:underline"
    >
      💬 {message.replyCount} réponse{message.replyCount > 1 ? "s" : ""}
    </button>
  );

  const reactionChips = message.reactions?.length > 0 && (
    <div className="mt-1 flex flex-wrap gap-1">
      {message.reactions.map((r) => {
        const mine = r.userIds?.includes(currentUser?.id);
        return (
          <button
            key={r.emoji}
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
        );
      })}
    </div>
  );

  if (grouped) {
    return (
      <div className="relative pl-12 pr-4 py-0.5 hover:bg-slate-50 group">
        {actions}
        {picker}
        <div className="flex items-start gap-2">
          <div className="text-xs text-slate-400 w-0 group-hover:w-10 overflow-hidden transition-all">
            {formatDate(message.createdAt)}
          </div>
          <div className="flex-1 min-w-0">
            {body}
            <Attachments attachments={message.attachments} />
            {footer}
            {reactionChips}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="relative px-2 py-1.5 hover:bg-slate-50 rounded group">
      {actions}
      {picker}
      <div className="flex items-start gap-2">
        <Avatar user={message.author} size={36} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-bold">{message.author?.displayName}</span>
            <span className="text-xs text-slate-500">{formatDate(message.createdAt)}</span>
          </div>
          {body}
          <Attachments attachments={message.attachments} />
          {footer}
          {reactionChips}
        </div>
      </div>
    </div>
  );
}
