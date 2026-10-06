import { test, expect } from "@playwright/test";

// Régression #346 — PWA absente de la feuille de partage (« Partager » depuis la
// pellicule photo).
//
// Diagnostic : le manifest de la PWA ne déclarait pas de `share_target`, donc les
// plateformes qui implémentent la Web Share Target API (Android/Chromium) ne
// proposaient jamais Murgat Chat comme destination de partage. Le correctif ajoute
// cette déclaration (POST multipart avec un champ fichiers `photos` acceptant les
// images) ; le service worker intercepte le POST `/share-target` et redirige vers
// `/?share-target=1` (voir web/src/sw.ts), où le client attache les photos au
// Composer.
//
// ⚠ iOS/Safari n'implémente pas (encore) cette API : aucune déclaration de manifest
// ne peut faire apparaître la PWA dans la feuille de partage iOS — c'est une limite
// de la plateforme. Ce test verrouille le contrat déclaratif côté manifest, qui est
// précisément l'élément qui manquait, et bénéficie à Android/Chromium (et au futur
// iOS). Le flux POST→SW→Composer dépend d'un service worker actif et de l'intent de
// partage de l'OS, non reproductibles via le harnais Playwright.

test("le manifest déclare une cible de partage pour les photos (#346)", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBeTruthy();

  const manifest = await res.json();
  const share = manifest.share_target;
  expect(share, "share_target doit être déclaré dans le manifest").toBeTruthy();

  // POST multipart : indispensable pour recevoir des fichiers (un GET ne porte
  // que titre/texte/url).
  expect(share.method?.toUpperCase()).toBe("POST");
  expect(share.enctype).toBe("multipart/form-data");
  expect(share.action).toBeTruthy();

  // Un champ fichiers qui accepte les images : c'est ce qui autorise le partage
  // de photos depuis la pellicule.
  const files = share.params?.files;
  expect(Array.isArray(files) && files.length > 0).toBeTruthy();
  const accepts = files.flatMap((f) => (Array.isArray(f.accept) ? f.accept : [f.accept]));
  expect(accepts.some((a) => typeof a === "string" && a.includes("image/"))).toBeTruthy();
});
