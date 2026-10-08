import { test, expect } from "@playwright/test";

// Régression #362 : la conversation « Mes notes » (self-DM) ne doit PLUS
// apparaître dans la liste des messages directs ; elle est épinglée en tête de
// la barre latérale, au même niveau que les sections (avant « Salons »).
// Comme journey.spec.js, ce spec a besoin d'une stack e2e isolée (DB vierge)
// pour bootstrapper son propre admin. Voir TESTING.md.

const tag = () => `e2e_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;
const API_URL = process.env.E2E_API_URL || "http://localhost:4001";

test.beforeEach(async ({ request }) => {
  // force IPv4 côté Node (Windows résout "localhost" en ::1, refusé).
  const res = await request.post(`${API_URL.replace("localhost", "127.0.0.1")}/test/reset`);
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`/test/reset failed: HTTP ${res.status()}`);
  }
});

async function configureServer(page) {
  const server = page.getByPlaceholder(/Adresse du serveur/);
  await expect(server).toBeVisible();
  await server.fill(API_URL);
  await page.getByRole("button", { name: "Tester" }).click();
  await expect(page.getByText(/joignable/)).toBeVisible();
}

// Premier compte : pas de code -> le serveur le bootstrappe en admin.
async function bootstrapAdmin(page) {
  const t = tag();
  await page.goto("/");
  await configureServer(page);
  const banner = page.getByRole("button", { name: "Créer le compte admin" });
  const inviteLink = page.getByRole("button", { name: /j'ai une invitation/i });
  if (await banner.count()) await banner.first().click();
  else await inviteLink.click();
  await expect(page.getByPlaceholder("Nom affiché")).toBeVisible();
  await page.getByPlaceholder("Nom affiché").fill(`Admin ${t}`);
  await page.getByPlaceholder("Nom d'utilisateur").fill(t);
  await page.getByPlaceholder("Email").fill(`${t}@e2e.local`);
  await page.getByPlaceholder("Mot de passe").fill("test1234");
  const submit = page.getByRole("button", { name: "Créer le compte admin", exact: true });
  if (await submit.count()) await submit.click();
  else await page.getByRole("button", { name: "S'inscrire", exact: true }).click();
  await expect(page.getByRole("button", { name: /Général/ })).toBeVisible();
  return t;
}

test("« Mes notes » est épinglée en tête et hors de la liste des DM (#362)", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await bootstrapAdmin(page);

  // Ouvre la conversation avec soi-même via la recherche unifiée : on tape, puis
  // on choisit l'action « Mes notes (conversation avec soi-même) » de « Créer ».
  await page.getByPlaceholder(/Rechercher ou créer/).fill("notes");
  await page.getByRole("button", { name: /Mes notes \(conversation avec soi-même\)/ }).click();

  // La conversation s'ouvre et la recherche se vide : la barre latérale réaffiche
  // ses sections. L'entrée épinglée « Mes notes » doit alors être présente.
  const notesEntry = page.getByRole("button", { name: /Mes notes/ });
  await expect(notesEntry).toBeVisible();

  // Elle est RETIRÉE des messages directs : la section « Messages directs » est
  // désormais vide (aucun autre DM n'existe), elle affiche « Aucun DM ».
  await expect(page.getByText("Aucun DM")).toBeVisible();

  // Elle est épinglée EN TÊTE : dans l'ordre du DOM, l'entrée « Mes notes »
  // précède la section « Salons » (donc aussi « Messages directs »).
  const order = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const notes = buttons.find(
      (b) => /Mes notes/.test(b.textContent || "") && !/soi-même/.test(b.textContent || "")
    );
    const salons = buttons.find((b) => /Salons/.test(b.textContent || ""));
    if (!notes || !salons) return "missing";
    const following = notes.compareDocumentPosition(salons) & Node.DOCUMENT_POSITION_FOLLOWING;
    return following ? "notes-before-salons" : "salons-before-notes";
  });
  expect(order).toBe("notes-before-salons");
});
