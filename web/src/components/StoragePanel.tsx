import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { fileIcon } from "../fileIcon.ts";

/** Réponse de GET /uploads/storage (server/src/routes/uploads.ts). */
interface StorageStats {
  /** Disque qui porte les pièces jointes, en octets. */
  disk: { total: number; available: number };
  /** Pièces jointes regroupées par type MIME et extension. */
  types: { mimeType: string; ext: string | null; count: number; bytes: number }[];
  /** Les plus gros fichiers ; `filename` est null quand l'admin n'a pas à le voir. */
  largest: {
    id: string;
    filename: string | null;
    mimeType: string;
    size: number;
    createdAt: string;
    place: string;
  }[];
}

/** Une ligne du détail par type, une fois les groupes du serveur fusionnés. */
interface Category {
  label: string;
  icon: string;
  tone: string;
  count: number;
  bytes: number;
}

const SECTION_TITLE = "text-[11px] font-semibold uppercase tracking-wide text-slate-400";

// Jusqu'au To : le disque du serveur se compte en Go, pas en Mo.
function fmtBytes(n: number) {
  const units = ["o", "ko", "Mo", "Go", "To"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toLocaleString("fr-FR", { maximumFractionDigits: i < 2 ? 0 : 1 })} ${units[i]}`;
}

function fileCount(n: number) {
  return `${n.toLocaleString("fr-FR")} fichier${n > 1 ? "s" : ""}`;
}

// Mêmes types que les icônes du fil (fileIcon), du plus lourd au plus léger,
// comme l'écran de stockage d'un OS.
function categories(types: StorageStats["types"]): Category[] {
  const byLabel = new Map<string, Category>();
  for (const t of types) {
    const { icon, label, tone } = fileIcon(t.mimeType, t.ext ? `.${t.ext}` : "");
    const cat = byLabel.get(label) ?? {
      label: label === "Fichier" ? "Autres fichiers" : label,
      icon,
      tone,
      count: 0,
      bytes: 0,
    };
    cat.count += t.count;
    cat.bytes += t.bytes;
    byLabel.set(label, cat);
  }
  return [...byLabel.values()].sort((a, b) => b.bytes - a.bytes);
}

// Onglet « Stockage » du panneau d'administration : place libre du disque, puis
// ce qui l'occupe dans les fichiers échangés sur le chat.
export default function StoragePanel() {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.storageStats().then(setStats, (e: Error) => setError(e.message || "Erreur de chargement"));
  }, []);

  if (error) return <div className="p-3 text-sm text-red-600">{error}</div>;
  if (!stats) return <div className="p-5 text-sm text-slate-500">Chargement…</div>;

  const { total, available } = stats.disk;
  const cats = categories(stats.types);
  const chatBytes = cats.reduce((sum, c) => sum + c.bytes, 0);
  const chatCount = cats.reduce((sum, c) => sum + c.count, 0);
  const parts = [
    { label: "Fichiers du chat", bytes: chatBytes, color: "bg-blue-500" },
    // Le reste de l'espace occupé : système, base de données, images Docker…
    {
      label: "Système et autres données",
      bytes: Math.max(0, total - available - chatBytes),
      color: "bg-slate-400",
    },
    { label: "Disponible", bytes: available, color: "bg-slate-200" },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-6">
      <section>
        <h3 className={SECTION_TITLE}>Disque du serveur</h3>
        <p className="mt-1">
          <span className="text-2xl font-semibold">{fmtBytes(available)}</span>{" "}
          <span className="text-sm text-slate-500">disponibles sur {fmtBytes(total)}</span>
        </p>
        <div className="mt-3 flex h-4 gap-0.5 overflow-hidden rounded">
          {parts
            .filter((p) => p.bytes > 0)
            .map((p) => (
              <div
                key={p.label}
                title={`${p.label} : ${fmtBytes(p.bytes)}`}
                className={`min-w-[3px] ${p.color}`}
                style={{ flexGrow: p.bytes / total, flexBasis: 0 }}
              />
            ))}
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
          {parts.map((p) => (
            <li key={p.label} className="flex items-center gap-1.5">
              <span className={`size-2.5 rounded-xs ${p.color}`} />
              {p.label}
              <span className="font-medium tabular-nums text-slate-900">{fmtBytes(p.bytes)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className={SECTION_TITLE}>Fichiers du chat</h3>
        <p className="mt-1 text-sm text-slate-500">
          {fmtBytes(chatBytes)} · {fileCount(chatCount)}
        </p>
        <ul className="mt-3 space-y-3">
          {cats.map((c) => (
            <li key={c.label} className="flex items-center gap-3">
              <span
                className={`grid size-9 shrink-0 place-items-center rounded-md text-lg ring-1 ring-inset ${c.tone}`}
              >
                {c.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate font-medium">{c.label}</span>
                  <span className="shrink-0 tabular-nums">{fmtBytes(c.bytes)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-blue-500"
                    style={{ width: `${(c.bytes / (chatBytes || 1)) * 100}%` }}
                  />
                </div>
                <div className="mt-0.5 text-xs text-slate-500">{fileCount(c.count)}</div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {stats.largest.length > 0 && (
        <section>
          <h3 className={SECTION_TITLE}>Plus gros fichiers</h3>
          <ul className="mt-1 divide-y divide-slate-100">
            {stats.largest.map((f) => (
              <li key={f.id} className="flex items-center gap-3 py-2">
                <span className="w-6 shrink-0 text-center">
                  {fileIcon(f.mimeType, f.filename ?? "").icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className={`truncate text-sm ${f.filename ? "" : "italic text-slate-500"}`}
                    title={f.filename ?? undefined}
                  >
                    {f.filename ?? "Fichier privé"}
                  </div>
                  <div className="truncate text-xs text-slate-500">
                    {f.place} · {new Date(f.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <span className="shrink-0 text-sm tabular-nums">{fmtBytes(f.size)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
