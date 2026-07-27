import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api.ts";
import Avatar from "./Avatar.tsx";
import type { Channel, User } from "../types.ts";

interface QuickSwitcherProps {
  query: string;
  user: User;
  channels: Channel[];
  onSelectChannel: (channel: Channel) => void;
  onJoined: (channel: Channel) => void;
  onOpened: (channel: Channel) => void;
  onCreateChannel: (name: string) => void;
  onNewGroup: () => void;
  onlineUserIds?: Set<string>;
}

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
}: QuickSwitcherProps) {
  const [publicRaw, setPublicRaw] = useState<Channel[]>([]);
  const [peopleRaw, setPeopleRaw] = useState<User[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Ligne surlignée pour la navigation clavier (#94). 0 = premier résultat.
  const [active, setActive] = useState(0);

  const q = query.trim();
  // Accent- and case-insensitive so "general" finds "Général", "reunion" → "Réunion".
  const norm = (s: string | null | undefined) =>
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

  async function join(c: Channel) {
    setBusyId(c.id);
    try {
      const res = await api.joinChannel(c.id);
      onJoined(res.channel);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function dm(u: User) {
    setBusyId(u.id);
    try {
      const res = await api.openDm([u.id]);
      onOpened(res.channel);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  const nothing =
    existing.length === 0 && publicChannels.length === 0 && people.length === 0;

  // Liste à plat des actions, dans l'ordre d'affichage des sections. C'est ce
  // que parcourent les flèches et qu'active la touche Entrée (#94). Les « bases »
  // donnent l'index global de la première ligne de chaque section, pour savoir
  // quelle ligne surligner.
  const items: Array<() => void> = [
    ...existing.map((c) => () => onSelectChannel(c)),
    ...publicChannels.map((c) => () => join(c)),
    ...people.map((u) => () => dm(u)),
    () => onCreateChannel(q),
    () => dm(user),
    () => onNewGroup(),
  ];
  const publicBase = existing.length;
  const peopleBase = publicBase + publicChannels.length;
  const createBase = peopleBase + people.length;

  // Quand les résultats changent, on resélectionne la première ligne.
  useEffect(() => {
    setActive(0);
  }, [ql, existing.length, publicChannels.length, people.length]);

  // Navigation clavier depuis le champ de recherche (qui garde le focus) : les
  // flèches déplacent la sélection, Entrée déclenche la ligne surlignée. On lit
  // les valeurs courantes via des refs pour garder un seul écouteur stable.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const list = itemsRef.current;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(i + 1, list.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        const run = list[activeRef.current];
        if (run) {
          e.preventDefault();
          run();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="space-y-4">
      {existing.length > 0 && (
        <Section title="Vos conversations">
          {existing.map((c, i) => (
            <Row
              key={c.id}
              active={active === i}
              onClick={() => onSelectChannel(c)}
              prefix={c.isDirect ? "💬" : c.isPrivate ? "🔒" : "#"}
              label={(c.isDirect ? c.displayName : c.name) || "conversation"}
            />
          ))}
        </Section>
      )}

      {publicChannels.length > 0 && (
        <Section title="Salons à rejoindre">
          {publicChannels.map((c, i) => (
            <Row
              key={c.id}
              active={active === publicBase + i}
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
          {people.map((u, i) => (
            <Row
              key={u.id}
              active={active === peopleBase + i}
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
        <Row
          active={active === createBase}
          onClick={() => onCreateChannel(q)}
          prefix="➕"
          label={`Créer le salon « ${q} »`}
        />
        <Row
          active={active === createBase + 1}
          onClick={() => dm(user)}
          busy={busyId === user.id}
          prefix="📝"
          label="Mes notes (conversation avec soi-même)"
        />
        <Row
          active={active === createBase + 2}
          onClick={onNewGroup}
          prefix="👥"
          label="Nouveau groupe de discussion"
        />
      </Section>

      {nothing && (
        <div className="text-xs text-aubergine-400 px-2">
          Aucune conversation ni personne trouvée — utilisez « Créer » ci-dessus.
        </div>
      )}
    </div>
  );
}

interface SectionProps {
  title: ReactNode;
  children: ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <div>
      <div className="px-2 mb-1 text-xs uppercase tracking-wide text-aubergine-400">
        {title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

interface RowProps {
  active: boolean;
  onClick: () => void;
  busy?: boolean;
  prefix?: ReactNode;
  avatar?: User;
  online?: boolean;
  label: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
}

function Row({ active, onClick, busy, prefix, avatar, online, label, sub, action }: RowProps) {
  const ref = useRef<HTMLButtonElement | null>(null);
  // Garde la ligne surlignée visible quand on la rejoint au clavier (#94).
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <button
      ref={ref}
      aria-selected={active}
      onClick={onClick}
      disabled={busy}
      className={`w-full flex items-center gap-2 px-3 py-2.5 md:py-1.5 rounded text-left text-[15px] md:text-sm hover:bg-aubergine-600 hover:text-white disabled:opacity-50 ${
        active ? "bg-aubergine-600 text-white" : "text-aubergine-400"
      }`}
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
        <span className="text-xs px-2 py-0.5 rounded-sm bg-aubergine-600 text-white shrink-0">
          {busy ? "…" : action}
        </span>
      )}
    </button>
  );
}
