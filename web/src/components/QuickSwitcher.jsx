import { useEffect, useState } from "react";
import { api } from "../api.js";
import Avatar from "./Avatar.jsx";

// Unified sidebar search. Rendered in place of the channel/DM lists while the
// search field has a query. One field replaces the old "browse public channels",
// "new channel" and "new DM" buttons: as you type it surfaces your existing
// conversations, public salons to join, people to DM, and create actions.
export default function QuickSwitcher({
  query,
  user,
  channels,
  onSelectChannel,
  onJoined,
  onOpened,
  onCreateChannel,
  onNewGroup,
  onlineUserIds,
}) {
  const [publicRaw, setPublicRaw] = useState([]);
  const [peopleRaw, setPeopleRaw] = useState([]);
  const [busyId, setBusyId] = useState(null);

  const q = query.trim();
  // Accent- and case-insensitive so "general" finds "Général", "reunion" → "Réunion".
  const norm = (s) =>
    (s || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const ql = norm(q);

  // Server-side discovery (public salons + users), debounced. Joined/self
  // filtering happens at render so it reacts to `channels` without re-querying.
  useEffect(() => {
    if (!q) {
      setPublicRaw([]);
      setPeopleRaw([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      Promise.all([api.publicChannels(q), api.listUsers(q)])
        .then(([pc, us]) => {
          if (cancelled) return;
          setPublicRaw(pc.channels || []);
          setPeopleRaw(us.users || []);
        })
        .catch(() => {
          /* transient — keep last results */
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  const joinedIds = new Set(channels.map((c) => c.id));
  const existing = channels.filter((c) =>
    norm(c.isDirect ? c.displayName : c.name).includes(ql)
  );
  const publicChannels = publicRaw.filter((c) => !joinedIds.has(c.id));
  const people = peopleRaw.filter((u) => u.id !== user.id);

  async function join(c) {
    setBusyId(c.id);
    try {
      const res = await api.joinChannel(c.id);
      onJoined(res.channel);
    } catch (e) {
      alert(e.message);
    } finally {
      setBusyId(null);
    }
  }

  async function dm(u) {
    setBusyId(u.id);
    try {
      const res = await api.openDm([u.id]);
      onOpened(res.channel);
    } catch (e) {
      alert(e.message);
    } finally {
      setBusyId(null);
    }
  }

  const nothing =
    existing.length === 0 && publicChannels.length === 0 && people.length === 0;

  return (
    <div className="space-y-4">
      {existing.length > 0 && (
        <Section title="Vos conversations">
          {existing.map((c) => (
            <Row
              key={c.id}
              onClick={() => onSelectChannel(c)}
              prefix={c.isDirect ? "💬" : c.isPrivate ? "🔒" : "#"}
              label={(c.isDirect ? c.displayName : c.name) || "conversation"}
            />
          ))}
        </Section>
      )}

      {publicChannels.length > 0 && (
        <Section title="Salons à rejoindre">
          {publicChannels.map((c) => (
            <Row
              key={c.id}
              onClick={() => join(c)}
              busy={busyId === c.id}
              prefix="#"
              label={c.name}
              sub={`${c.members.length} membre${c.members.length > 1 ? "s" : ""}${
                c.description ? ` · ${c.description}` : ""
              }`}
              action="Rejoindre"
            />
          ))}
        </Section>
      )}

      {people.length > 0 && (
        <Section title="Personnes">
          {people.map((u) => (
            <Row
              key={u.id}
              onClick={() => dm(u)}
              busy={busyId === u.id}
              avatar={u}
              online={onlineUserIds?.has(u.id)}
              label={u.displayName}
              sub={`@${u.username}`}
            />
          ))}
        </Section>
      )}

      <Section title="Créer">
        <Row onClick={() => onCreateChannel(q)} prefix="➕" label={`Créer le salon « ${q} »`} />
        <Row onClick={onNewGroup} prefix="👥" label="Nouveau groupe de discussion" />
      </Section>

      {nothing && (
        <div className="text-xs text-aubergine-400 px-2">
          Aucune conversation ni personne trouvée — utilisez « Créer » ci-dessus.
        </div>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <div className="px-2 mb-1 text-xs uppercase tracking-wide text-aubergine-400">
        {title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({ onClick, busy, prefix, avatar, online, label, sub, action }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="w-full flex items-center gap-2 px-3 py-2.5 md:py-1.5 rounded text-left text-[15px] md:text-sm text-aubergine-400 hover:bg-aubergine-600 hover:text-white disabled:opacity-50"
    >
      {avatar ? (
        <span className="relative shrink-0">
          <Avatar user={avatar} size={20} />
          {online != null && (
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-aubergine-700 ${
                online ? "bg-green-400" : "bg-slate-500"
              }`}
            />
          )}
        </span>
      ) : (
        <span className="opacity-80 w-5 text-center shrink-0">{prefix}</span>
      )}
      <span className="flex-1 min-w-0">
        <span className="block truncate">{label}</span>
        {sub && <span className="block truncate text-xs text-aubergine-400">{sub}</span>}
      </span>
      {action && (
        <span className="text-xs px-2 py-0.5 rounded bg-aubergine-600 text-white shrink-0">
          {busy ? "…" : action}
        </span>
      )}
    </button>
  );
}
