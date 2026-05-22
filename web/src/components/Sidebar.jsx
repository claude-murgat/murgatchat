import { useState } from "react";
import Avatar from "./Avatar.jsx";

function dndLabel(user) {
  if (!user?.dndUntil) return null;
  const until = new Date(user.dndUntil);
  if (until <= new Date()) return null;
  return `Ne pas déranger · jusqu'à ${until.toLocaleTimeString([], {
    hour: "2-digit",
    minutes: "2-digit",
  })}`;
}

export default function Sidebar({
  user,
  channels,
  activeChannelId,
  onSelectChannel,
  onNewChannel,
  onNewDm,
  onToggleDnd,
  onLogout,
  onBrowseChannels,
  onlineUserIds,
  typingByChannel,
}) {
  const [showMenu, setShowMenu] = useState(false);
  const groups = channels.filter((c) => !c.isDirect);
  const dms = channels.filter((c) => c.isDirect);

  const dnd = dndLabel(user);

  return (
    <aside className="bg-aubergine-700 text-white w-72 shrink-0 flex flex-col h-full">
      <div className="px-4 py-3 border-b border-aubergine-600 flex items-center justify-between relative">
        <div>
          <div className="font-bold text-lg leading-tight">Chat Workspace</div>
          <button
            onClick={() => setShowMenu((s) => !s)}
            className="text-xs text-aubergine-400 hover:text-white flex items-center gap-1"
          >
            <span className="inline-block w-2 h-2 rounded-full bg-green-400" />
            {user.displayName} <span>▾</span>
          </button>
          {dnd && <div className="text-[11px] text-yellow-300 mt-0.5">{dnd}</div>}
        </div>
        {showMenu && (
          <div className="absolute right-3 top-14 bg-white text-slate-800 rounded-md shadow-lg overflow-hidden z-30 w-56">
            <button
              onClick={() => {
                setShowMenu(false);
                onToggleDnd();
              }}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
            >
              {user.dndUntil && new Date(user.dndUntil) > new Date()
                ? "Désactiver Ne pas déranger"
                : "Activer Ne pas déranger"}
            </button>
            <button
              onClick={() => {
                setShowMenu(false);
                onLogout();
              }}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-100 text-red-600"
            >
              Se déconnecter
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin px-2 py-3 space-y-4">
        <SidebarSection title="Salons" onAdd={onNewChannel} onBrowse={onBrowseChannels}>
          {groups.map((c) => (
            <SidebarItem
              key={c.id}
              active={c.id === activeChannelId}
              onClick={() => onSelectChannel(c)}
              prefix={c.isPrivate ? "🔒" : "#"}
              label={c.name || "salon"}
              unread={c.unread}
            />
          ))}
          {groups.length === 0 && (
            <div className="text-xs text-aubergine-400 px-2 py-1">Aucun salon</div>
          )}
        </SidebarSection>

        <SidebarSection title="Messages directs" onAdd={onNewDm}>
          {dms.map((c) => {
            const other = c.members.find((m) => m.id !== user.id) || c.members[0];
            const isGroup = c.members.length > 2;
            const isTyping = (typingByChannel?.[c.id]?.length || 0) > 0;
            return (
              <button
                key={c.id}
                onClick={() => onSelectChannel(c)}
                className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left ${
                  c.id === activeChannelId
                    ? "bg-slackblue text-white"
                    : c.unread
                    ? "text-white font-semibold hover:bg-aubergine-600"
                    : "text-aubergine-400 hover:bg-aubergine-600 hover:text-white"
                }`}
              >
                {isTyping ? (
                  <span
                    className="w-5 h-5 shrink-0 rounded grid place-items-center bg-aubergine-500 text-white text-[11px] font-bold animate-pulse"
                    title="En train d'écrire…"
                  >
                    …
                  </span>
                ) : isGroup ? (
                  <span
                    className="w-5 h-5 shrink-0 rounded grid place-items-center bg-aubergine-500 text-white text-[11px] font-semibold"
                    title={`Groupe · ${c.members.length} personnes`}
                  >
                    {c.members.length}
                  </span>
                ) : (
                  <Avatar user={other} size={20} />
                )}
                {!isGroup && (
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      onlineUserIds?.has(other?.id) ? "bg-green-400" : "bg-slate-500"
                    }`}
                    title={onlineUserIds?.has(other?.id) ? "En ligne" : "Hors ligne"}
                  />
                )}
                <span className="truncate flex-1">{c.displayName || "DM"}</span>
                {c.unread && c.id !== activeChannelId && (
                  <span className="w-2 h-2 rounded-full bg-white shrink-0" />
                )}
              </button>
            );
          })}
          {dms.length === 0 && (
            <div className="text-xs text-aubergine-400 px-2 py-1">Aucun DM</div>
          )}
        </SidebarSection>
      </div>
    </aside>
  );
}

function SidebarSection({ title, onAdd, onBrowse, children }) {
  return (
    <div>
      <div className="flex items-center justify-between px-2 mb-1 text-xs uppercase tracking-wide text-aubergine-400">
        <span>{title}</span>
        <div className="flex items-center gap-1.5">
          {onBrowse && (
            <button
              onClick={onBrowse}
              className="hover:text-white text-[11px]"
              title="Parcourir les salons publics"
            >
              🔍
            </button>
          )}
          <button
            onClick={onAdd}
            className="hover:text-white"
            title={`Ajouter — ${title}`}
          >
            +
          </button>
        </div>
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function SidebarItem({ active, onClick, prefix, label, unread }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2 py-1 rounded flex items-center gap-2 ${
        active
          ? "bg-slackblue text-white"
          : unread
          ? "text-white font-semibold hover:bg-aubergine-600"
          : "text-aubergine-400 hover:bg-aubergine-600 hover:text-white"
      }`}
    >
      <span className="opacity-80">{prefix}</span>
      <span className="truncate flex-1">{label}</span>
      {unread && !active && (
        <span className="w-2 h-2 rounded-full bg-white shrink-0" />
      )}
    </button>
  );
}
