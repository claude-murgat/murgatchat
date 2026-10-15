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
  /** Classes Tailwind (fond + liseré) de la pastille qui porte l'icône sur la
   *  carte de pièce jointe, pour distinguer les formats par la couleur. */
  tone: string;
}

/** Extension du nom de fichier, en minuscules (« » si aucune). */
export function extOf(name = "") {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

export function fileIcon(mime = "", filename = ""): FileIcon {
  const ext = extOf(filename);
  if (mime.startsWith("image/"))
    return { icon: "🖼️", label: "Image", tone: "bg-sky-50 ring-sky-100" };
  if (mime.startsWith("video/"))
    return { icon: "🎬", label: "Vidéo", tone: "bg-violet-50 ring-violet-100" };
  if (mime.startsWith("audio/"))
    return { icon: "🎵", label: "Audio", tone: "bg-pink-50 ring-pink-100" };
  if (mime === "application/pdf" || ext === "pdf")
    return { icon: "📕", label: "Document PDF", tone: "bg-red-50 ring-red-100" };
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword" ||
    ext === "docx" ||
    ext === "doc"
  )
    return { icon: "📘", label: "Document Word", tone: "bg-blue-50 ring-blue-100" };
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel" ||
    mime === "text/csv" ||
    ext === "xlsx" ||
    ext === "xls" ||
    ext === "csv" ||
    ext === "tsv"
  )
    return { icon: "📊", label: "Feuille de calcul", tone: "bg-emerald-50 ring-emerald-100" };
  if (
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mime === "application/vnd.ms-powerpoint" ||
    ext === "pptx" ||
    ext === "ppt"
  )
    return { icon: "📙", label: "Présentation", tone: "bg-orange-50 ring-orange-100" };
  if (
    mime === "application/zip" ||
    mime === "application/x-rar-compressed" ||
    mime === "application/x-7z-compressed" ||
    mime === "application/gzip" ||
    mime === "application/x-tar" ||
    ["zip", "rar", "7z", "gz", "tgz", "tar", "bz2"].includes(ext)
  )
    return { icon: "🗜️", label: "Archive", tone: "bg-amber-50 ring-amber-100" };
  if (mime.startsWith("text/"))
    return { icon: "📄", label: "Document texte", tone: "bg-slate-100 ring-slate-200" };
  return { icon: "📎", label: "Fichier", tone: "bg-slate-100 ring-slate-200" };
}
