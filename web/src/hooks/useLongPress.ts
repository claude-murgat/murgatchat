import { useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from "react";

/** Coordonnées viewport où ouvrir un menu contextuel (appui long / clic droit). */
export interface LongPressPosition {
  x: number;
  y: number;
}

/** Ce que le code lit du point de contact (un `Touch`, ou l'évènement en repli). */
interface ClientPoint {
  clientX: number;
  clientY: number;
}

/**
 * Appui long (mobile/PWA) + clic droit (desktop) pour ouvrir un menu contextuel.
 * Renvoie les gestionnaires à étaler sur l'élément ainsi qu'un `onClickCapture`
 * qui neutralise le clic parasite déclenché après un appui long (sinon le clic
 * de relâchement du doigt retomberait sur l'élément, ou sur le backdrop du menu
 * qu'il refermerait aussitôt).
 */
export function useLongPress(onLongPress: (pos: LongPressPosition) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clear, []);
  return {
    handlers: {
      onTouchStart: (e: ReactTouchEvent) => {
        fired.current = false;
        const point = (e.touches?.[0] || e) as ClientPoint;
        const x = point.clientX;
        const y = point.clientY;
        clear();
        timer.current = setTimeout(() => {
          fired.current = true;
          onLongPress({ x, y });
        }, 500);
      },
      onTouchEnd: (e: ReactTouchEvent) => {
        // Après un appui long, on supprime le clic synthétique du navigateur :
        // sinon il retomberait sur le backdrop du menu et le refermerait aussitôt.
        // onClickCapture reste un garde-fou desktop.
        if (fired.current) e.preventDefault();
        clear();
      },
      onTouchMove: clear,
      onContextMenu: (e: ReactMouseEvent) => {
        // Clic droit desktop (et menu natif de certains appuis longs).
        e.preventDefault();
        fired.current = true;
        onLongPress({ x: e.clientX, y: e.clientY });
      },
    },
    onClickCapture: (e: ReactMouseEvent) => {
      if (fired.current) {
        e.preventDefault();
        e.stopPropagation();
        fired.current = false;
      }
    },
  };
}
