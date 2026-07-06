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
  "txt", "md", "markdown", "log", "json", "xml",
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
  if (mime === "text/csv" || ext === "csv" || ext === "tsv") return "csv";
  if (mime.startsWith("text/") || TEXT_EXTS.has(ext)) return "text";
  return "other";
}

function fmtCell(v) {
  if (v == null) return "";
  if (v instanceof Date) return v.toLocaleString();
  return String(v);
}

// Right-align numeric cells like a spreadsheet does (real numbers from xlsx, or
// number-looking strings from csv).
function isNumericCell(v) {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") {
    const t = v.trim();
    return t !== "" && /^-?\d+(?:[.,]\d+)?$/.test(t);
  }
  return false;
}

// Spreadsheet column label: 0 -> A, 25 -> Z, 26 -> AA, …
function colLabel(n) {
  let s = "";
  let x = n + 1;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

// Minimal RFC-4180 CSV parser with delimiter auto-detection (comma / semicolon /
// tab — Excel FR exports use ";"). Handles quoted fields, "" escapes and CRLF.
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const nl = text.indexOf("\n");
  const firstLine = nl >= 0 ? text.slice(0, nl) : text;
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let scanQ = false;
  for (const ch of firstLine) {
    if (ch === '"') scanQ = !scanQ;
    else if (!scanQ && ch in counts) counts[ch]++;
  }
  const delim =
    Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
      ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
      : ",";

  const rows = [];
  let row = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
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

// Spreadsheet-style grid shared by the Excel and CSV viewers: a gray frame of
// column letters (A, B, …) and row numbers (1, 2, …) around white cells with
// gridlines, numbers right-aligned. The frame stays put while scrolling.
function SheetGrid({ rows }) {
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const headers = Array.from({ length: cols }, (_, i) => colLabel(i));
  return (
    <table className="border-collapse text-sm text-slate-800 tabular-nums">
      <thead>
        <tr>
          <th className="sticky top-0 left-0 z-20 bg-slate-200 border border-slate-300 w-10" />
          {headers.map((h, i) => (
            <th
              key={i}
              className="sticky top-0 z-10 bg-slate-200 border border-slate-300 px-2 py-0.5 font-medium text-slate-500 text-center min-w-[3.5rem]"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri}>
            <td className="sticky left-0 z-10 bg-slate-200 border border-slate-300 px-2 py-0.5 text-slate-500 text-center select-none">
              {ri + 1}
            </td>
            {headers.map((_, ci) => {
              const cell = row[ci];
              return (
                <td
                  key={ci}
                  className={`border border-slate-200 px-2 py-0.5 align-top whitespace-pre-wrap break-words max-w-[24rem] ${
                    isNumericCell(cell) ? "text-right" : ""
                  }`}
                >
                  {fmtCell(cell)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Excel: read-excel-file parses .xlsx into rows of typed cells. Sheets become
// bottom tabs (like Excel) and are parsed lazily on selection; rows/cols are
// capped so a huge sheet can't freeze the tab.
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
      <div className="flex-1 overflow-auto scroll-thin">
        {rows === null ? (
          <div className="p-6 text-slate-500 text-sm">Chargement de la feuille…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-slate-500 text-sm">Feuille vide.</div>
        ) : (
          <SheetGrid rows={rows} />
        )}
      </div>
      {truncated && (
        <div className="px-3 py-1 text-xs text-amber-700 bg-amber-50 border-t border-amber-200 shrink-0">
          Aperçu tronqué aux {MAX_ROWS} premières lignes — téléchargez le fichier pour tout voir.
        </div>
      )}
      {sheets.length > 1 && (
        <div className="flex items-stretch gap-0.5 px-2 pt-1 border-t border-slate-300 bg-slate-100 shrink-0 overflow-x-auto scroll-thin">
          {sheets.map((s, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              className={`px-3 py-1 text-sm whitespace-nowrap border border-b-0 rounded-t ${
                i === active
                  ? "bg-white text-slate-900 border-slate-300 font-medium"
                  : "bg-slate-200/60 text-slate-600 border-transparent hover:bg-slate-200"
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// CSV: parsed client-side and shown in the same spreadsheet grid as Excel.
function CsvView({ buffer, onError }) {
  const rows = useMemo(() => {
    try {
      const text = new TextDecoder("utf-8").decode(buffer);
      return parseCsv(text)
        .slice(0, MAX_ROWS)
        .map((r) => r.slice(0, MAX_COLS));
    } catch {
      return null;
    }
  }, [buffer]);
  useEffect(() => {
    if (rows === null) onError();
  }, [rows, onError]);
  if (rows === null) return null;
  return (
    <div className="w-[94vw] max-w-5xl h-[82vh] flex flex-col bg-white rounded-lg overflow-hidden">
      <div className="flex-1 overflow-auto scroll-thin">
        {rows.length === 0 ? (
          <div className="p-6 text-slate-500 text-sm">Fichier vide.</div>
        ) : (
          <SheetGrid rows={rows} />
        )}
      </div>
    </div>
  );
}

// Word: mammoth converts the .docx to semantic HTML; DOMPurify strips anything
// unsafe before it's injected (the document is untrusted user content). Links are
// forced to open externally so a click can't navigate the app away. Rendered on a
// document "page" (see .docx-page / .docx-preview in styles.css).
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
    <div className="w-[92vw] max-w-[900px] h-[82vh] overflow-auto bg-slate-300/40 rounded-lg scroll-thin">
      <div className="docx-page">
        {/* Sanitized above with DOMPurify; mammoth emits a limited, styled HTML set. */}
        <div className="docx-preview" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}

// Plain text / code: decode as UTF-8 and show it verbatim, capped in length.
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
  if (kind === "csv") return <CsvView buffer={buf.buffer} onError={onError} />;
  return <TextView buffer={buf.buffer} onError={onError} />;
}

// Lightbox modal for a single attachment: previews it in place (image/video/
// audio/pdf, plus Word/Excel/CSV/text rendered client-side) and offers a reliable
// download. Opened from the message list instead of navigating to the raw
// server URL in a new tab.
export default function AttachmentModal({ attachment, onClose }) {
  const url = attachmentUrl(attachment.id); // already carries ?token=…
  const downloadUrl = `${url}&download=1`; // server → Content-Disposition: attachment
  const kind = kindOf(attachment.mimeType, attachment.filename);
  const isDocument =
    kind === "docx" || kind === "xlsx" || kind === "csv" || kind === "text";

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
