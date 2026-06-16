import { useEffect } from "react";
import { attachmentUrl } from "../api.js";
import { isTauri, openExternal } from "../desktop.js";

function fmtBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

function kindOf(mime = "") {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  return "other";
}

// Lightbox modal for a single attachment: previews it in place (image/video/
// audio/pdf) and offers a reliable download. Opened from the message list
// instead of navigating to the raw server URL in a new tab.
export default function AttachmentModal({ attachment, onClose }) {
  const url = attachmentUrl(attachment.id); // already carries ?token=…
  const downloadUrl = `${url}&download=1`; // server → Content-Disposition: attachment
  const kind = kindOf(attachment.mimeType);

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
          {kind === "other" && (
            <div className="bg-white rounded-lg p-8 text-center text-slate-700 max-w-sm">
              <div className="text-5xl mb-3">📄</div>
              <div className="font-medium truncate">{attachment.filename}</div>
              <div className="text-sm text-slate-500 mt-1">{fmtBytes(attachment.size)}</div>
              <p className="text-sm text-slate-500 mt-3">
                Aperçu indisponible pour ce type de fichier.
              </p>
              <button
                onClick={download}
                className="mt-4 px-4 py-2 rounded-md bg-aubergine-700 text-white text-sm"
              >
                ⬇ Télécharger
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
