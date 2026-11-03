import { test, expect } from "@playwright/test";

// Liste des salons sur mobile (gabarit iPhone, 390×844) : un salon au nom très
// long — typiquement un ancien groupe converti, nommé d'après ses membres
// (jusqu'à 80 caractères) — doit être tronqué, sans élargir la page ni
// provoquer de scroll horizontal (#438).
test.use({ viewport: { width: 390, height: 844 } });

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
// Requêtes côté Node : forcer IPv4 (Windows résout "localhost" en ::1).
const API = API_URL.replace("localhost", "127.0.0.1");
const tag = () => `ovf_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

test.beforeEach(async ({ request }) => {
  const res = await request.post(`${API}/test/reset`);
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`/test/reset failed: HTTP ${res.status()}`);
  }
});

async function call(request, token, method, path, data) {
  const res = await request.fetch(`${API}${path}`, {
    method,
    data,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok()) throw new Error(`${method} ${path} → HTTP ${res.status()} ${await res.text()}`);
  return res.json();
}

test("un nom de salon très long ne fait pas déborder la liste sur mobile", async ({
  page,
  request,
}) => {
  const t = tag();
  const admin = await call(request, null, "POST", "/auth/register", {
    email: `${t}@e2e.local`,
    username: t,
    displayName: `Admin ${t}`,
    password: "test1234",
  });
  const name = "Alexandre Dupont, Bérénice Martin, Charles-Henri Lefebvre et Dominique";
  await call(request, admin.token, "POST", "/channels", { name, isPrivate: true, memberIds: [] });

  await page.addInitScript(
    ([token, base]) => {
      localStorage.setItem("chat_token", token);
      localStorage.setItem("chat_api_base", base);
    },
    [admin.token, API_URL]
  );
  await page.goto("/");

  // Sur mobile, l'app rouvre d'emblée #Général en plein écran : revenir à la liste.
  const back = page.getByRole("button", { name: "Retour à la liste des conversations" });
  const salon = page.getByRole("button", { name: /Alexandre Dupont/ }).first();
  await expect(back.or(salon).first()).toBeVisible();
  if (await back.isVisible()) await back.click();
  await expect(salon).toBeVisible();

  // Pas de scroll horizontal : la page garde la largeur de l'écran.
  const widths = await page.evaluate(() => ({
    scroll: document.scrollingElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.viewport);

  // La ligne du salon tient dans l'écran (son nom est tronqué, pas l'écran élargi).
  const box = await salon.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(390 + 1);
});
