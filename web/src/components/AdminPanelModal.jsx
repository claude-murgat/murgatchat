import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import Avatar from "./Avatar.jsx";

const PAGE_SIZE = 50;

// Hierarchy: owner > admin > member. The current user is `me`.
// What the UI offers per target is decided here; the server enforces it again.
function actionsFor(me, target) {
  if (target.id === me.id) return []; // never act on yourself in this panel
  if (target.isOwner) return []; // owner is untouchable except via transfer

  const out = [];
  // Promote / revoke admin: owner only
  if (me.isOwner) {
    out.push(
      target.isAdmin
        ? { key: "revoke", label: "Révoquer admin", danger: false }
        : { key: "promote", label: "Promouvoir admin", danger: false }
    );
  }
  // Disable / re-enable
  if (target.status === "disabled") {
    out.push({ key: "enable", label: "Réactiver", danger: false });
  } else {
    // Admin can disable members; owner can disable admins too.
    if (!target.isAdmin || me.isOwner) {
      out.push({ key: "disable", label: "Désactiver", danger: true });
    }
  }
  // Transfer ownership: owner only, target must be active
  if (me.isOwner && target.status !== "disabled") {
    out.push({ key: "transfer", label: "Transférer la propriété", danger: true });
  }
  return out;
}

function roleBadge(u) {
  if (u.isOwner)
    return <span className="text-[11px] font-semibold text-amber-700 bg-amber-100 rounded px-1.5 py-0.5">Propriétaire</span>;
  if (u.isAdmin)
    return <span className="text-[11px] font-semibold text-blue-700 bg-blue-100 rounded px-1.5 py-0.5">Admin</span>;
  return <span className="text-[11px] text-slate-500">Membre</span>;
}

export default function AdminPanelModal({ currentUser, onClose, onUserUpdated }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null); // {target, action}
  // Track the latest fetch so a stale debounced response can't overwrite the
  // current view (typing fast triggers many in-flight requests).
  const fetchSeq = useRef(0);

  async function fetchPage({ p, q, append }) {
    const seq = ++fetchSeq.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const res = await api.listAdminUsers({ page: p, pageSize: PAGE_SIZE, q });
      if (seq !== fetchSeq.current) return; // a newer fetch superseded us
      setUsers((prev) => (append ? [...prev, ...res.users] : res.users));
      setHasMore(res.hasMore);
      setTotal(res.total);
      setPage(p);
    } catch (e) {
      if (seq === fetchSeq.current) setError(e.message || "Erreur de chargement");
    } finally {
      if (seq === fetchSeq.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  // Debounced search: every query change resets to page 1 after 300 ms idle.
  useEffect(() => {
    const t = setTimeout(() => fetchPage({ p: 1, q: query.trim(), append: false }), 300);
    return () => clearTimeout(t);
  }, [query]);

  function loadMore() {
    if (!hasMore || loadingMore) return;
    fetchPage({ p: page + 1, q: query.trim(), append: true });
  }

  async function refreshCurrentView() {
    // Re-fetch the first `page * PAGE_SIZE` rows so a role/status mutation is
    // reflected without scrolling the user back to the top.
    const seq = ++fetchSeq.current;
    try {
      const res = await api.listAdminUsers({
        page: 1,
        pageSize: page * PAGE_SIZE,
        q: query.trim(),
      });
      if (seq !== fetchSeq.current) return;
      setUsers(res.users);
      setHasMore(res.hasMore);
      setTotal(res.total);
    } catch {
      /* ignore — the immediate update below still patches in-place */
    }
  }

  async function runAction(target, action) {
    setBusyId(target.id);
    setError(null);
    try {
      let res;
      if (action === "promote") res = await api.patchUser(target.id, { isAdmin: true });
      else if (action === "revoke") res = await api.patchUser(target.id, { isAdmin: false });
      else if (action === "disable")
        res = await api.patchUser(target.id, { status: "disabled" });
      else if (action === "enable")
        res = await api.patchUser(target.id, { status: "active" });
      else if (action === "transfer") {
        await api.transferOwnership(target.id);
        await refreshCurrentView();
        // After transfer the *current* user is no longer owner — bubble it up.
        const me = (await api.me()).user;
        onUserUpdated?.(me);
        return;
      }
      if (res?.user) {
        setUsers((prev) => prev.map((u) => (u.id === res.user.id ? res.user : u)));
        if (res.user.id === currentUser.id) onUserUpdated?.(res.user);
      }
    } catch (e) {
      setError(e.data?.error || e.message || "Erreur");
    } finally {
      setBusyId(null);
      setConfirmAction(null);
    }
  }

  function requestAction(target, action) {
    // High-impact actions go through a confirmation prompt.
    if (action === "disable" || action === "transfer") {
      setConfirmAction({ target, action });
    } else {
      runAction(target, action);
    }
  }

  const confirmText = confirmAction
    ? confirmAction.action === "disable"
      ? `Désactiver ${confirmAction.target.displayName} ? L'utilisateur ne pourra plus se connecter et perdra l'accès à toutes les conversations. Son historique de messages est conservé.`
      : `Transférer la propriété à ${confirmAction.target.displayName} ? Vous deviendrez simple administrateur ; seul le nouveau propriétaire pourra vous rendre la propriété.`
    : "";

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-stretch sm:place-items-center z-50 p-0 sm:p-4" onClick={onClose}>
      <div
        className="bg-white text-slate-900 sm:rounded-xl shadow-2xl w-full h-full sm:h-auto sm:max-w-2xl sm:max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-slate-200">
          <h2 className="text-xl font-bold">Administration</h2>
          <p className="text-sm text-slate-500 mt-1">
            {currentUser.isOwner ? "Propriétaire" : "Administrateur"} — gérez rôles, accès et propriété.
          </p>
        </div>
        <div className="p-3 border-b border-slate-200">
          <input
            className="w-full border rounded-md px-3 py-2 text-sm"
            placeholder="Rechercher (nom, username, email)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && <div className="p-5 text-sm text-slate-500">Chargement…</div>}
          {error && <div className="p-3 text-sm text-red-600">{error}</div>}
          {!loading && users.length === 0 && (
            <div className="p-5 text-sm text-slate-500">Aucun résultat.</div>
          )}
          <ul className="divide-y divide-slate-100">
            {users.map((u) => {
              const actions = actionsFor(currentUser, u);
              const disabled = u.status === "disabled";
              return (
                <li key={u.id} className="p-3 flex items-center gap-3">
                  <Avatar user={u} size={32} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-medium truncate ${disabled ? "text-slate-400 line-through" : ""}`}>
                        {u.displayName}
                      </span>
                      {roleBadge(u)}
                      {disabled && (
                        <span className="text-[11px] font-semibold text-slate-600 bg-slate-200 rounded px-1.5 py-0.5">
                          Désactivé
                        </span>
                      )}
                      {u.id === currentUser.id && (
                        <span className="text-[11px] text-slate-500">(vous)</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 truncate">
                      @{u.username} · {u.email}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1 justify-end">
                    {actions.length === 0 && (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                    {actions.map((a) => (
                      <button
                        key={a.key}
                        disabled={busyId === u.id}
                        onClick={() => requestAction(u, a.key)}
                        className={`text-xs px-2 py-1 rounded border ${
                          a.danger
                            ? "border-red-300 text-red-700 hover:bg-red-50"
                            : "border-slate-300 text-slate-700 hover:bg-slate-50"
                        } disabled:opacity-50`}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          {!loading && hasMore && (
            <div className="p-3 text-center border-t border-slate-100">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="px-3 py-1.5 text-sm rounded-md border border-slate-300 hover:bg-slate-50 disabled:opacity-50"
              >
                {loadingMore ? "Chargement…" : "Voir plus"}
              </button>
            </div>
          )}
        </div>
        <div className="p-3 border-t border-slate-200 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            {users.length} / {total} affiché{total > 1 ? "s" : ""}
          </span>
          <button onClick={onClose} className="px-3 py-1.5 rounded-md border border-slate-300">
            Fermer
          </button>
        </div>

        {confirmAction && (
          <div
            className="fixed inset-0 bg-black/50 grid place-items-stretch sm:place-items-center z-[60] p-0 sm:p-4"
            onClick={() => setConfirmAction(null)}
          >
            <div
              className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="font-bold text-lg mb-2">Confirmer</h3>
              <p className="text-sm text-slate-700">{confirmText}</p>
              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={() => setConfirmAction(null)}
                  className="px-3 py-1.5 rounded-md border border-slate-300 text-sm"
                >
                  Annuler
                </button>
                <button
                  onClick={() => runAction(confirmAction.target, confirmAction.action)}
                  disabled={busyId === confirmAction.target.id}
                  className="px-3 py-1.5 rounded-md bg-red-600 text-white text-sm disabled:opacity-50"
                >
                  {busyId === confirmAction.target.id ? "…" : "Confirmer"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
