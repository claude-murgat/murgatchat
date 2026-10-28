import { test, expect } from "@playwright/test";

// Une section repliée de la barre latérale (Salons, Messages directs, Claude)
// cache les pastilles « Non lu » de ses conversations : son en-tête en affiche
// alors le total. Comme sync.spec.js, ce spec vise la stack e2e isolée (DB
// vierge) et crée son compte par l'API. Voir TESTING.md.

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
// Requêtes côté Node : forcer IPv4 (Windows résout "localhost" en ::1).
const API = API_URL.replace("localhost", "127.0.0.1");
const tag = () => `side_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

test.beforeEach(async ({ request }) => {
  const res = await request.post(`${API}/test/reset`);
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`/test/reset failed: HTTP ${res.status()}`);
  }
});

test("une section repliée affiche le nombre de conversations non lues", async ({
  page,
  request,
}) => {
  // Premier compte : bootstrappé admin, membre de « Général ».
  const t = tag();
  const res = await request.post(`${API}/auth/register`, {
    data: { email: `${t}@e2e.local`, username: t, displayName: `Admin ${t}`, password: "test1234" },
  });
  expect(res.ok()).toBe(true);
  const { token } = await res.json();
  await page.addInitScript(
    ([tok, base]) => {
      localStorage.setItem("chat_token", tok);
      localStorage.setItem("chat_api_base", base);
    },
    [token, API_URL]
  );
  await page.goto("/");

  const general = page.getByRole("button", { name: /Général/ }).first();
  await general.click({ button: "right" });
  await page.getByRole("button", { name: "Marquer comme non lu" }).click();
  await expect(general.getByTitle("Non lu")).toBeVisible();

  // Repliée : la pastille de la ligne disparaît, l'en-tête affiche le total.
  const salons = page.getByRole("button", { name: /^Salons/ });
  await salons.click();
  await expect(salons).toHaveAttribute("aria-expanded", "false");
  await expect(salons.getByText("1", { exact: true })).toBeVisible();
  await expect(salons).toHaveAttribute("title", "Déplier Salons (1 conversation non lue)");

  // Dépliée : le total s'efface, la pastille de la ligne revient.
  await salons.click();
  await expect(salons.getByText("1", { exact: true })).toHaveCount(0);
  await expect(general.getByTitle("Non lu")).toBeVisible();
});
