// Icône « Télécharger » (flèche vers un bac) en SVG inline. Remplace le glyphe
// ⬇, rendu de façon très inégale selon la plateforme : fine flèche presque
// invisible sur Windows/Linux, emoji carré bleu sur iOS/Android, voire « tofu »
// sans police emoji couleur (même problème que le trombone, cf. #102).

interface DownloadIconProps {
  className?: string;
}

export default function DownloadIcon({ className = "size-4" }: DownloadIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}
