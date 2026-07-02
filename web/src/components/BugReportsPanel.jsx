import { useEffect, useRef, useState } from "react";
import { api, attachmentUrl } from "../api.js";

const PAGE_SIZE = 30;

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function StatusBadge({ status }) {
  return status === "closed" ? (
    <span className="text-[11px] font-semibold text-slate-600 bg-slate-200 rounded px-1.5 py-0.5">
      Résolu
    </span>
  ) : (
    <span className="text-[11px] font-semibold text-amber-700 bg-amber-100 rounded px-1.5 py-0.5">
      Ouvert
    </span>
  );
}

function PlatformBadge({ platform }) {
  return (
    <span className="text-[11px] font-medium text-blue-700 bg-blue-50 rounded px-1.5 py-0.5">
      {platform}
    </span>
  );
}

// Detail view shown when a report is expanded: full message, diagnostics
// key/values, and the raw captured logs (with a one-click copy).
function ReportDetail({ report }) {
  const [copied, setCopied] = useState(false);
  const diag = report.diagnostics && typeof report.diagnostics === "object"
    ? report.diagnostics
    : null;

  async function copyAll() {
    const text =
      `Rapport #${report.id}\n` +
      `De: ${report.user ? "@" + report.user.username : "utilisateur supprimé"}\n` +
      `Date: ${fmtDate(report.createdAt)}\n\n` +
      `Message:\n${report.message}\n\n` +
      (diag
        ? `=== Diagnostic ===\n${Object.entries(diag)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n")}\n\n`
        : "") +
      (report.logs ? `=== Logs ===\n${report.logs}` : "");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="mt-2 space-y-3">
      <div className="text-sm whitespace-pre-wrap break-words bg-slate-50 border border-slate-200 rounded p-2">
        {report.message}
      </div>

      {Array.isArray(report.attachments) && report.attachments.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
            Pièces jointes
          </div>
          <div className="flex flex-wrap gap-2">
            {report.attachments.map((a) => (
              <a
                key={a.id}
                href={attachmentUrl(a.id)}
                target="_blank"
                rel="noreferrer"
                title={a.filename}
                className="block"
              >
                {a.mimeType?.startsWith("image/") ? (
                  <img
                    src={attachmentUrl(a.id)}
                    alt={a.filename}
                    className="h-20 w-20 object-cover rounded border border-slate-200"
                  />
                ) : (
                  <span className="text-[12px] underline text-blue-700 break-all">
                    {a.filename}
                  </span>
                )}
              </a>
            ))}
          </div>
        </div>
      )}

      {diag && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
            Diagnostic
          </div>
          <dl className="text-[12px] grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5">
            {Object.entries(diag).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-slate-400">{k}</dt>
                <dd className="text-slate-700 break-words min-w-0">{String(v)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {report.logs && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Logs
            </span>
            <button
              onClick={copyAll}
              className="text-[11px] px-2 py-0.5 rounded border border-slate-300 hover:bg-slate-50"
            >
              {copied ? "Copié ✓" : "Copier le rapport"}
            </button>
          </div>
          <pre className="text-[11px] leading-snug bg-slate-50 border border-slate-200 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-slate-700">
            {report.logs}
          </pre>
        </div>
      )}
    </div>
  );
}

// "Rapports de bug" tab of the Administration panel. Renders the filter row +
// scrollable list; meant to sit inside the modal's flex-col body (between the
// tab nav and the shared footer).
export default function BugReportsPanel() {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [statusFilter, setStatusFilter] = useState("open"); // "open" | "" (all)
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [openCount, setOpenCount] = useState(0);
  const [expandedId, setExpandedId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const fetchSeq = useRef(0);

  async function fetchPage({ p, status, append }) {
    const seq = ++fetchSeq.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const res = await api.listBugReports({ page: p, pageSize: PAGE_SIZE, status });
      if (seq !== fetchSeq.current) return;
      setReports((prev) => (append ? [...prev, ...res.reports] : res.reports));
      setHasMore(res.hasMore);
      setTotal(res.total);
      setOpenCount(res.openCount);
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

  useEffect(() => {
    fetchPage({ p: 1, status: statusFilter, append: false });
  }, [statusFilter]);

  async function changeStatus(report, status) {
    setBusyId(report.id);
    setError(null);
    try {
      const res = await api.updateBugReport(report.id, status);
      setReports((prev) => {
        // When viewing only "open", a resolved report leaves the list.
        if (statusFilter === "open" && status === "closed") {
          return prev.filter((x) => x.id !== report.id);
        }
        return prev.map((x) => (x.id === report.id ? res.report : x));
      });
      setOpenCount((c) => (status === "closed" ? Math.max(0, c - 1) : c + 1));
    } catch (e) {
      setError(e.data?.error || e.message || "Erreur");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(report) {
    setBusyId(report.id);
    setError(null);
    try {
      await api.deleteBugReport(report.id);
      setReports((prev) => prev.filter((x) => x.id !== report.id));
      setTotal((t) => Math.max(0, t - 1));
      if (report.status === "open") setOpenCount((c) => Math.max(0, c - 1));
    } catch (e) {
      setError(e.data?.error || e.message || "Erreur");
    } finally {
      setBusyId(null);
      setConfirmDelete(null);
    }
  }

  const FilterButton = ({ value, label }) => (
    <button
      onClick={() => setStatusFilter(value)}
      className={`px-2.5 py-1 rounded-md border text-xs ${
        statusFilter === value
          ? "border-aubergine-500 bg-aubergine-50 text-aubergine-800 font-medium"
          : "border-slate-300 text-slate-600 hover:bg-slate-50"
      }`}
    >
      {label}
    </button>
  );

  return (
    <>
      <div className="p-3 border-b border-slate-200 flex items-center gap-2">
        <span className="text-xs text-slate-500">Filtre&nbsp;:</span>
        <FilterButton value="open" label={`Ouverts (${openCount})`} />
        <FilterButton value="" label={`Tous (${total})`} />
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && <div className="p-5 text-sm text-slate-500">Chargement…</div>}
        {error && <div className="p-3 text-sm text-red-600">{error}</div>}
        {!loading && reports.length === 0 && (
          <div className="p-5 text-sm text-slate-500">Aucun rapport.</div>
        )}
        <ul className="divide-y divide-slate-100">
          {reports.map((r) => {
            const expanded = expandedId === r.id;
            return (
              <li key={r.id} className="p-3">
                <button
                  onClick={() => setExpandedId(expanded ? null : r.id)}
                  className="text-left w-full"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusBadge status={r.status} />
                    {r.platform && <PlatformBadge platform={r.platform} />}
                    {r.appVersion && (
                      <span className="text-[11px] text-slate-500">v{r.appVersion}</span>
                    )}
                    <span className="text-[11px] text-slate-400">
                      {fmtDate(r.createdAt)}
                    </span>
                  </div>
                  <div
                    className={`text-sm mt-1 ${expanded ? "" : "truncate"} ${
                      r.status === "closed" ? "text-slate-500" : ""
                    }`}
                  >
                    {r.message}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {r.user ? `@${r.user.username}` : "utilisateur supprimé"}
                  </div>
                </button>

                {expanded && (
                  <>
                    <ReportDetail report={r} />
                    <div className="flex flex-wrap items-center gap-1 justify-between mt-2">
                      {r.githubIssueUrl ? (
                        <a
                          href={r.githubIssueUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-aubergine-700 hover:underline"
                        >
                          Issue GitHub #{r.githubIssueNumber}
                        </a>
                      ) : (
                        <span />
                      )}
                      <div className="flex flex-wrap gap-1">
                        {r.status === "open" ? (
                          <button
                            disabled={busyId === r.id}
                            onClick={() => changeStatus(r, "closed")}
                            className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            Marquer résolu
                          </button>
                        ) : (
                          <button
                            disabled={busyId === r.id}
                            onClick={() => changeStatus(r, "open")}
                            className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            Rouvrir
                          </button>
                        )}
                        <button
                          disabled={busyId === r.id}
                          onClick={() => setConfirmDelete(r)}
                          className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          Supprimer
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {!loading && hasMore && (
          <div className="p-3 text-center border-t border-slate-100">
            <button
              onClick={() => fetchPage({ p: page + 1, status: statusFilter, append: true })}
              disabled={loadingMore}
              className="px-3 py-1.5 text-sm rounded-md border border-slate-300 hover:bg-slate-50 disabled:opacity-50"
            >
              {loadingMore ? "Chargement…" : "Voir plus"}
            </button>
          </div>
        )}
      </div>

      {confirmDelete && (
        <div
          className="fixed inset-0 bg-black/50 grid place-items-stretch sm:place-items-center z-[60] p-0 sm:p-4"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-bold text-lg mb-2">Supprimer le rapport</h3>
            <p className="text-sm text-slate-700">
              Supprimer définitivement ce rapport&nbsp;? Cette action est irréversible.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-3 py-1.5 rounded-md border border-slate-300 text-sm"
              >
                Annuler
              </button>
              <button
                onClick={() => remove(confirmDelete)}
                disabled={busyId === confirmDelete.id}
                className="px-3 py-1.5 rounded-md bg-red-600 text-white text-sm disabled:opacity-50"
              >
                {busyId === confirmDelete.id ? "…" : "Supprimer"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
