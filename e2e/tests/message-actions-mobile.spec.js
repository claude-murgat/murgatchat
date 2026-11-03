import { test, expect } from "@playwright/test";

// Appui long sur mobile (PWA iOS/Android) : la barre d'actions d'un message
// n'apparaît sinon qu'au survol (`group-hover`), inaccessible au tactile. Un
// appui long doit la révéler pour rendre Modifier / Transférer utilisables (#439).

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
// Requêtes côté Node : forcer IPv4 (Windows résout "localhost" en ::1).
const API = API_URL.replace("localhost", "127.0.0.1");
const tag = () => `lp_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

// Contexte tactile sans survol possible, gabarit iPhone (390×844).
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

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

// Un compte (admin bootstrap) et un salon privé pour ne pas polluer « Général ».
async function setup(request) {
  const a = tag();
  const admin = await call(request, null, "POST", "/auth/register", {
    email: `${a}@e2e.local`,
    username: a,
    displayName: `Admin ${a}`,
    password: "test1234",
  });
  const { channel: priv } = await call(request, admin.token, "POST", "/channels", {
    name: `prive-${a}`,
    isPrivate: true,
    memberIds: [],
  });
  return { admin, priv };
}

// Ouvre l'app déjà connectée : jeton + adresse serveur posés avant le boot.
async function openAs(browser, session) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  await context.addInitScript(
    ([token, base]) => {
      localStorage.setItem("chat_token", token);
      localStorage.setItem("chat_api_base", base);
    },
    [session.token, API_URL]
  );
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto("/");
  return page;
}

const chat = (page) =>
  page.locator("section").filter({ has: page.getByPlaceholder(/^Message (dans|à) /) });

const messageRow = (page, text) => page.locator("div.group").filter({ hasText: text }).last();

// Sur mobile, l'app rouvre d'emblée #Général en plein écran : la liste des
// salons est masquée, il faut d'abord revenir à la liste.
async function openChannel(page, name) {
  const back = page.getByRole("button", { name: "Retour à la liste des conversations" });
  const entry = page.getByRole("button", { name: new RegExp(name) }).first();
  await expect(back.or(entry).first()).toBeVisible();
  if (await back.isVisible()) await back.click();
  // Bandeau d'installation PWA : on le masque pour dégager le fil.
  const hideBanner = page.getByRole("button", { name: "Masquer", exact: true });
  if (await hideBanner.count()) await hideBanner.first().click();
  await entry.click();
  await expect(page.getByPlaceholder(`Message dans #${name}`)).toBeVisible();
}

async function send(page, name, text) {
  const composer = page.getByPlaceholder(`Message dans #${name}`);
  await composer.fill(text);
  await composer.press("Enter");
  await expect(chat(page).getByText(text)).toBeVisible();
}

// Simule un appui long : touchstart maintenu 600 ms (> seuil de 500 ms) puis
// touchend, comme un doigt posé sur le message.
async function longPress(row) {
  await row.dispatchEvent("touchstart", { bubbles: true, cancelable: true, touches: [] });
  await row.page().waitForTimeout(600);
  await row.dispatchEvent("touchend", { bubbles: true, cancelable: true, touches: [] });
}

test("long-press reveals message actions on touch devices", async ({ browser, request }) => {
  const { admin, priv } = await setup(request);
  const me = await openAs(browser, admin);
  await openChannel(me, priv.name);
  await send(me, priv.name, "mon message tactile");

  const row = messageRow(me, "mon message tactile");

  // Sans survol (tactile), la barre d'actions est masquée au départ.
  await expect(row.getByRole("button", { name: "Modifier" })).toBeHidden();

  // L'appui long la révèle : Modifier et Transférer deviennent accessibles.
  await longPress(row);
  await expect(row.getByRole("button", { name: "Modifier" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Transférer" })).toBeVisible();

  // Modifier bascule bien le message en édition (champ + bouton Enregistrer) —
  // au doigt, comme sur téléphone : le tap suivant l'appui long n'est pas avalé.
  await row.getByRole("button", { name: "Modifier" }).tap();
  await expect(me.getByRole("button", { name: "Enregistrer" })).toBeVisible();
});
