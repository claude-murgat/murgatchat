import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { attachmentUrl } from "../api.js";
import { isTauri, openExternal } from "../desktop.js";

// Office previews are heavy parsers; they're loaded on demand (dynamic import)
// only when a matching file is actually opened, so they never weigh on the main
// bundle. Rendered entirely client-side — the bytes are decrypted+served behind
// auth, so nothing is ever handed to an external viewer (Office Online / Google).
const MAX_TEXT = 500_000; // chars rendered for a plain-text file
const MAX_ROWS = 500; // rows rendered per spreadsheet sheet
const MAX_COLS = 40; // columns rendered per spreadsheet row

function fmtBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

function extOf(name = "") {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "log", "csv", "tsv", "json", "xml",
  "yml", "yaml", "ini", "conf", "env", "sql",
]);

// Map an attachment to a preview strategy. MIME is checked first, with a
// filename-extension fallback because the server may store the generic
// application/octet-stream for office files uploaded by some clients.
function kindOf(mime = "", filename = "") {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  const ext = extOf(filename);
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  )
    return "docx";
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    ext === "xlsx"
  )
    return "xlsx";
  if (mime.startsWith("text/") || TEXT_EXTS.has(ext)) return "text";
  return "other";
}

function fmtCell(v) {
  if (v == null) return "";
  if (v instanceof Date) return v.toLocaleString();
  return String(v);
}

function Spinner({ label }) {
  return (
    <div className="flex flex-col items-center gap-3 text-white/80">
      <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
      <div className="text-sm">{label}</div>
    </div>
  );
}

// Shown for file types we can't render (legacy .doc/.xls, archives, …) and as
// the graceful fallback whenever fetching or parsing a document preview fails.
function FallbackCard({ attachment, onDownload, note }) {
  return (
    <div className="bg-white rounded-lg p-8 text-center text-slate-700 max-w-sm">
      <div className="text-5xl mb-3">📄</div>
      <div className="font-medium truncate">{attachment.filename}</div>
      <div className="text-sm text-slate-500 mt-1">{fmtBytes(attachment.size)}</div>
      <p className="text-sm text-slate-500 mt-3">
        {note || "Aperçu indisponible pour ce type de fichier."}
      </p>
      <button
        onClick={onDownload}
        className="mt-4 px-4 py-2 rounded-md bg-aubergine-700 text-white text-sm"
      >
        ⬇ Télécharger
      </button>
    </div>
  );
}

// Fetch the raw (decrypted) bytes once, with auth carried by the ?token= in the
// URL — a simple cross-origin GET, so no CORS preflight. Returns a discriminated
// state the document viewers switch on.
function useFetchedBuffer(url) {
  const [state, setState] = useState({ status: "loading" });
  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buffer) => {
        if (alive) setState({ status: "ready", buffer });
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [url]);
  return state;
}

// Word: mammoth converts the .docx to semantic HTML; DOMPurify strips anything
// unsafe before it's injected (the document is untrusted user content). Links are
// forced to open externally so a click can't navigate the app away.
function DocxView({ buffer, onError }) {
  const [html, setHtml] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [{ default: mammoth }, { default: DOMPurify }] = await Promise.all([
          import("mammoth"),
          import("dompurify"),
        ]);
        const { value } = await mammoth.convertToHtml({ arrayBuffer: buffer });
        DOMPurify.addHook("afterSanitizeAttributes", (node) => {
          if (node.tagName === "A") {
            node.setAttribute("target", "_blank");
            node.setAttribute("rel", "noreferrer noopener");
          }
        });
        const clean = DOMPurify.sanitize(value || "", { ADD_ATTR: ["target", "rel"] });
        DOMPurify.removeHook("afterSanitizeAttributes");
        if (alive) setHtml(clean || "<p></p>");
      } catch {
        if (alive) onError();
      }
    })();
    return () => {
      alive = false;
    };
  }, [buffer, onError]);

  if (html === null) return <Spinner label="Rendu du document…" />;
  return (
    <div className="w-[92vw] max-w-3xl h-[82vh] overflow-auto bg-white rounded-lg scroll-thin">
      {/* Sanitized above with DOMPurify; mammoth emits a limited, styled HTML set. */}
      <div className="docx-preview" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

// Excel: read-excel-file parses .xlsx into rows of typed cells. Sheets become
// tabs and are parsed lazily on selection; rows/cols are capped so a huge sheet
// can't freeze the tab.
function XlsxView({ buffer, onError }) {
  const [sheets, setSheets] = useState(null);
  const [active, setActive] = useState(0);
  const [rows, setRows] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const readRef = useRef(null);
  const blobRef = useRef(null);

  // Load the parser + sheet list once.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const mod = await import("read-excel-file/browser");
        readRef.current = mod.default;
        blobRef.current = new Blob([buffer]);
        const list = await readRef.current(blobRef.current, { getSheets: true });
        // read-excel-file v9 returns [{ sheet:<name>, data:<rows> }] and already
        // parses each sheet's rows; older docs say [{ name }]. Normalize both and
        // keep the embedded rows when present (avoids a second parse per sheet).
        const norm = (Array.isArray(list) && list.length ? list : [{}]).map((s, i) => ({
          name: s.name ?? s.sheet ?? `Feuille ${i + 1}`,
          data: Array.isArray(s.data) ? s.data : null,
        }));
        if (alive) setSheets(norm);
      } catch {
        if (alive) onError();
      }
    })();
    return () => {
      alive = false;
    };
  }, [buffer, onError]);

  // Parse the selected sheet.
  useEffect(() => {
    if (!sheets || !readRef.current || !blobRef.current) return;
    let alive = true;
    setRows(null);
    (async () => {
      try {
        let data = sheets[active]?.data;
        // Fall back to a 1-based index read (never by name — v9's `sheet` option
        // is index-based; passing a name silently returns the wrong shape).
        if (!data) data = await readRef.current(blobRef.current, { sheet: active + 1 });
        let r = Array.isArray(data) ? data : [];
        const trunc = r.length > MAX_ROWS;
        if (trunc) r = r.slice(0, MAX_ROWS);
        r = r.map((row) => (row.length > MAX_COLS ? row.slice(0, MAX_COLS) : row));
        if (alive) {
          setRows(r);
          setTruncated(trunc);
        }
      } catch {
        if (alive) onError();
      }
    })();
    return () => {
      alive = false;
    };
  }, [sheets, active, onError]);

  if (!sheets) return <Spinner label="Ouverture du classeur…" />;
  return (
    <div className="w-[94vw] max-w-5xl h-[82vh] flex flex-col bg-white rounded-lg overflow-hidden">
      {sheets.length > 1 && (
        <div className="flex gap-1 p-2 border-b border-slate-200 overflow-x-auto shrink-0">
          {sheets.map((s, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              className={`px-3 py-1 rounded text-sm whitespace-nowrap ${
                i === active
                  ? "bg-aubergine-700 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-auto scroll-thin">
        {rows === null ? (
          <div className="p-6 text-slate-500 text-sm">Chargement de la feuille…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-slate-500 text-sm">Feuille vide.</div>
        ) : (
          <table className="border-collapse text-sm text-slate-800">
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className={ri % 2 ? "bg-white" : "bg-slate-50/60"}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className={`border border-slate-200 px-2 py-1 align-top whitespace-pre-wrap break-words max-w-[24rem] ${
                        ri === 0 ? "bg-slate-100 font-medium sticky top-0 z-10" : ""
                      }`}
                    >
                      {fmtCell(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {truncated && (
        <div className="p-2 text-xs text-slate-500 border-t border-slate-200 shrink-0">
          Aperçu tronqué aux {MAX_ROWS} premières lignes — téléchargez le fichier pour tout voir.
        </div>
      )}
    </div>
  );
}

// Plain text / code / csv: decode as UTF-8 and show it verbatim, capped in length.
function TextView({ buffer, onError }) {
  const text = useMemo(() => {
    try {
      return new TextDecoder("utf-8").decode(buffer).slice(0, MAX_TEXT);
    } catch {
      return null;
    }
  }, [buffer]);
  useEffect(() => {
    if (text === null) onError();
  }, [text, onError]);
  if (text === null) return null;
  return (
    <div className="w-[92vw] max-w-3xl h-[82vh] overflow-auto bg-white rounded-lg scroll-thin">
      <pre className="p-4 text-sm text-slate-800 whitespace-pre-wrap break-words font-mono">
        {text}
      </pre>
    </div>
  );
}

// Orchestrates a document preview: fetch bytes, then hand them to the right
// viewer. Any fetch/parse failure falls back to the download card so a file is
// never stranded behind a broken preview.
function DocumentPreview({ url, kind, attachment, onDownload }) {
  const [failed, setFailed] = useState(false);
  const onError = useCallback(() => setFailed(true), []);
  const buf = useFetchedBuffer(url);

  if (failed || buf.status === "error") {
    return (
      <FallbackCard
        attachment={attachment}
        onDownload={onDownload}
        note="Aperçu impossible pour ce fichier. Téléchargez-le pour l'ouvrir."
      />
    );
  }
  if (buf.status === "loading") return <Spinner label="Chargement du fichier…" />;
  if (kind === "docx") return <DocxView buffer={buf.buffer} onError={onError} />;
  if (kind === "xlsx") return <XlsxView buffer={buf.buffer} onError={onError} />;
  return <TextView buffer={buf.buffer} onError={onError} />;
}

// Lightbox modal for a single attachment: previews it in place (image/video/
// audio/pdf, plus Word/Excel/text rendered client-side) and offers a reliable
// download. Opened from the message list instead of navigating to the raw
// server URL in a new tab.
export default function AttachmentModal({ attachment, onClose }) {
  const url = attachmentUrl(attachment.id); // already carries ?token=…
  const downloadUrl = `${url}&download=1`; // server → Content-Disposition: attachment
  const kind = kindOf(attachment.mimeType, attachment.filename);
  const isDocument = kind === "docx" || kind === "xlsx" || kind === "text";

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function download() {
    // Under Tauri, window/anchor navigation to an http(s) URL is swallowed by the
    // webview (#43) — route through the opener so it reaches the OS browser, which
    // downloads it (the server sends Content-Disposition: attachment).
    if (isTauri()) {
      openExternal(downloadUrl);
      return;
    }
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = attachment.filename || "";
    a.rel = "noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <div className="fixed inset-0 bg-black/80 z-[60] flex flex-col" onClick={onClose}>
      <div
        className="flex items-center gap-2 p-3 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="flex-1 min-w-0 truncate text-sm">
          {attachment.filename}
          <span className="text-white/60"> · {fmtBytes(attachment.size)}</span>
        </span>
        <button
          onClick={download}
          className="px-3 py-1.5 rounded-md bg-white/15 hover:bg-white/25 text-sm font-medium"
        >
          ⬇ Télécharger
        </button>
        <button
          onClick={onClose}
          title="Fermer (Échap)"
          aria-label="Fermer"
          className="w-9 h-9 grid place-items-center rounded-md hover:bg-white/15 text-xl leading-none"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 min-h-0 grid place-items-center p-4" onClick={onClose}>
        <div className="max-w-full max-h-full" onClick={(e) => e.stopPropagation()}>
          {kind === "image" && (
            <img
              src={url}
              alt={attachment.filename}
              className="max-w-[92vw] max-h-[82vh] object-contain rounded"
            />
          )}
          {kind === "video" && (
            <video
              src={url}
              controls
              autoPlay
              className="max-w-[92vw] max-h-[82vh] rounded bg-black"
            />
          )}
          {kind === "audio" && (
            <div className="bg-white rounded-lg p-6 w-[88vw] max-w-md">
              <div className="text-5xl text-center mb-4">🎵</div>
              <audio src={url} controls className="w-full" />
            </div>
          )}
          {kind === "pdf" && (
            <iframe
              src={url}
              title={attachment.filename}
              className="w-[92vw] h-[82vh] bg-white rounded"
            />
          )}
          {isDocument && (
            <DocumentPreview
              url={url}
              kind={kind}
              attachment={attachment}
              onDownload={download}
            />
          )}
          {kind === "other" && <FallbackCard attachment={attachment} onDownload={download} />}
        </div>
      </div>
    </div>
  );
}
