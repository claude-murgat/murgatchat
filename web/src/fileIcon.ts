// Issue #371 : chaque pièce jointe doit porter une icône représentative de son
// type (PDF, Word, Excel, PowerPoint, archive…) plutôt qu'une icône générique
// unique, pour reconnaître le format d'un coup d'œil. Les images, elles, sont
// déjà rendues sous forme de vignette d'aperçu par le composant appelant.
//
// On teste d'abord le type MIME puis, en repli, l'extension du nom de fichier :
// certains clients téléversent les documents Office en application/octet-stream
// (même raisonnement que `kindOf()` dans AttachmentModal.tsx).

export interface FileIcon {
  /** Emoji affiché devant le nom du fichier. */
  icon: string;
  /** Libellé lisible du type, utilisé comme infobulle (`title`). */
  label: string;
}

function extOf(name = "") {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

export function fileIcon(mime = "", filename = ""): FileIcon {
  const ext = extOf(filename);
  if (mime.startsWith("image/")) return { icon: "🖼️", label: "Image" };
  if (mime.startsWith("video/")) return { icon: "🎬", label: "Vidéo" };
  if (mime.startsWith("audio/")) return { icon: "🎵", label: "Audio" };
  if (mime === "application/pdf" || ext === "pdf")
    return { icon: "📕", label: "Document PDF" };
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword" ||
    ext === "docx" ||
    ext === "doc"
  )
    return { icon: "📘", label: "Document Word" };
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel" ||
    mime === "text/csv" ||
    ext === "xlsx" ||
    ext === "xls" ||
    ext === "csv" ||
    ext === "tsv"
  )
    return { icon: "📊", label: "Feuille de calcul" };
  if (
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mime === "application/vnd.ms-powerpoint" ||
    ext === "pptx" ||
    ext === "ppt"
  )
    return { icon: "📙", label: "Présentation" };
  if (
    mime === "application/zip" ||
    mime === "application/x-rar-compressed" ||
    mime === "application/x-7z-compressed" ||
    mime === "application/gzip" ||
    mime === "application/x-tar" ||
    ["zip", "rar", "7z", "gz", "tgz", "tar", "bz2"].includes(ext)
  )
    return { icon: "🗜️", label: "Archive" };
  if (mime.startsWith("text/")) return { icon: "📄", label: "Document texte" };
  return { icon: "📎", label: "Fichier" };
}
