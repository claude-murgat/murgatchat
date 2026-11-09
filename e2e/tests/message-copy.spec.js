import { test, expect } from "@playwright/test";

// Clic droit sur un message (desktop web) : la barre d'actions s'ouvre et le
// bouton « Copier » recopie le texte du message dans le presse-papiers — le
// menu natif du navigateur étant neutralisé, c'est la seule voie de copie au
// clic droit (#457).

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
// Requêtes côté Node : forcer IPv4 (Windows résout "localhost" en ::1).
const API = API_URL.replace("localhost", "127.0.0.1");
const tag = () => `cp_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

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

// Ouvre l'app déjà connectée, avec l'accès presse-papiers autorisé.
async function openAs(browser, session) {
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
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

async function openChannel(page, name) {
  await page.getByRole("button", { name: new RegExp(name) }).first().click();
  await expect(page.getByPlaceholder(`Message dans #${name}`)).toBeVisible();
}

async function send(page, name, text) {
  const composer = page.getByPlaceholder(`Message dans #${name}`);
  await composer.fill(text);
  await composer.press("Enter");
  await expect(chat(page).getByText(text)).toBeVisible();
}

test("le clic droit ouvre un menu dont « Copier » recopie le message", async ({
  browser,
  request,
}) => {
  const { admin, priv } = await setup(request);
  const me = await openAs(browser, admin);
  await openChannel(me, priv.name);

  const texte = "message à copier au clic droit";
  await send(me, priv.name, texte);

  const row = messageRow(me, texte);

  // Clic droit : le menu natif est neutralisé et la barre d'actions s'ouvre.
  await row.click({ button: "right" });
  const copier = row.getByRole("button", { name: "Copier", exact: true });
  await expect(copier).toBeVisible();

  // Le clic recopie le texte du message et confirme (« Copié ✓ »).
  await copier.click();
  await expect(row.getByRole("button", { name: "Copié ✓" })).toBeVisible();

  const presse = await me.evaluate(() => navigator.clipboard.readText());
  expect(presse).toBe(texte);
});
