import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Ferme une modale au clic sur le fond, sans se laisser piéger par un GLISSER.
 *
 * Le motif naïf — `onClick={onClose}` sur le fond, `stopPropagation()` sur le
 * panneau — a un défaut qui a coûté l'issue #191 : un événement `click` ne se
 * déclenche pas sur la cible du relâchement, mais sur l'ANCÊTRE COMMUN du
 * `mousedown` et du `mouseup`. Sélectionner le texte d'un champ en glissant
 * jusqu'en dehors du panneau donne donc pour cible le fond lui-même : le
 * `stopPropagation()` du panneau n'est jamais traversé, et la modale se ferme
 * alors que l'utilisateur n'a jamais eu l'intention de cliquer à côté.
 *
 * On ne se fie donc pas au `click` seul : on exige que l'appui ET le
 * relâchement aient tous deux eu lieu directement sur le fond. `e.target ===
 * e.currentTarget` distingue le fond de tout ce qu'il contient, puisque les
 * événements du panneau remontent jusqu'ici avec leur cible d'origine.
 *
 * À brancher sur l'élément de fond : `<div className="fixed inset-0 …"
 * {...useOverlayDismiss(onClose)}>`.
 */
export function useOverlayDismiss(onClose: () => void) {
  const pressedOnOverlay = useRef(false);
  const releasedOnOverlay = useRef(false);

  return {
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      pressedOnOverlay.current = e.target === e.currentTarget;
    },
    onPointerUp(e: ReactPointerEvent<HTMLElement>) {
      releasedOnOverlay.current = e.target === e.currentTarget;
    },
    onClick() {
      const onBackdrop = pressedOnOverlay.current && releasedOnOverlay.current;
      // Remis à zéro systématiquement : un `click` sans paire pointer/pointerup
      // (clavier, événement synthétique) ne doit pas hériter du geste précédent.
      pressedOnOverlay.current = false;
      releasedOnOverlay.current = false;
      if (onBackdrop) onClose();
    },
  };
}
