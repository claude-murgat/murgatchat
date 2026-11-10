import { test, expect } from "@playwright/test";

// Clic droit sur un message (#457) : le menu d'actions s'ouvre à l'endroit du
// curseur, et « Copier » recopie le texte du message dans le presse-papiers. Sur
// du texte sélectionné ou un lien, le menu du navigateur reste disponible.

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

const copierDans = (row) => row.getByRole("button", { name: "Copier", exact: true });
// Le menu ouvert au curseur. Le fond transparent, lui aussi fixe, n'a pas de bouton.
const menuAuCurseur = (row) =>
  row.locator("div.fixed").filter({ has: row.page().getByRole("button") });

test("le clic droit ouvre, au curseur, un menu dont « Copier » recopie le message", async ({
  browser,
  request,
}) => {
  const { admin, priv } = await setup(request);
  const me = await openAs(browser, admin);
  await openChannel(me, priv.name);

  const texte = "message à copier au clic droit";
  await send(me, priv.name, texte);

  const row = messageRow(me, texte);
  const ligne = await row.boundingBox();
  // À gauche de la ligne : la barre visible au survol est, elle, calée à droite.
  // Vérifier la seule visibilité de « Copier » ne prouverait donc rien.
  const x = Math.round(ligne.x + 80);
  const y = Math.round(ligne.y + ligne.height / 2);

  await me.mouse.click(x, y, { button: "right" });
  await expect(copierDans(row)).toBeVisible();

  const menu = await menuAuCurseur(row).boundingBox();
  const fenetre = me.viewportSize();
  expect(Math.round(menu.x)).toBe(Math.min(x, fenetre.width - 200));
  expect(Math.round(menu.y)).toBe(Math.min(y, fenetre.height - 200));

  // Le clic recopie le texte du message et confirme (« Copié ✓ »).
  await copierDans(row).click();
  await expect(row.getByRole("button", { name: "Copié ✓" })).toBeVisible();

  const presse = await me.evaluate(() => navigator.clipboard.readText());
  expect(presse).toBe(texte);

  // Le menu se referme une fois la copie confirmée.
  await expect(menuAuCurseur(row)).toHaveCount(0);
});

// Un vrai glissé de souris : `selectText()` pose la sélection par script, sans le
// survol qui fait apparaître la barre d'actions dans le texte sélectionné.
async function glisser(page, de, a) {
  await page.mouse.move(de.x, de.y);
  await page.mouse.down();
  await page.mouse.move(a.x, a.y, { steps: 15 });
  await page.mouse.up();
}

const milieu = (boite, dx) => ({ x: boite.x + dx, y: boite.y + boite.height / 2 });
const selection = (page) => page.evaluate(() => window.getSelection().toString());
const clicDroit = (page, point) => page.mouse.click(point.x, point.y, { button: "right" });

// Au niveau du document, le gestionnaire de React a déjà été exécuté.
const surveillerMenuNatif = (page) =>
  page.evaluate(() => {
    document.addEventListener("contextmenu", (e) => {
      window.__menuNatifBloque = e.defaultPrevented;
    });
  });
const menuNatifBloque = (page) => page.evaluate(() => window.__menuNatifBloque);

test("clic droit sur du texte sélectionné : le menu du navigateur reste disponible", async ({
  browser,
  request,
}) => {
  const { admin, priv } = await setup(request);
  const me = await openAs(browser, admin);
  await openChannel(me, priv.name);

  const texte = "message dont on copie un extrait";
  await send(me, priv.name, texte);

  const row = messageRow(me, texte);
  const boite = await row.getByText(texte, { exact: true }).boundingBox();
  await glisser(me, milieu(boite, 1), milieu(boite, 90));
  expect(await selection(me)).not.toBe("");

  await surveillerMenuNatif(me);
  await clicDroit(me, milieu(boite, 40));

  expect(await menuNatifBloque(me)).toBe(false);
  // Et l'app n'ouvre pas son propre menu par-dessus.
  await expect(menuAuCurseur(row)).toHaveCount(0);
});

test("sélection sur deux messages : clic droit natif sur chacun, sans l'interface dans le texte", async ({
  browser,
  request,
}) => {
  const { admin, priv } = await setup(request);
  const me = await openAs(browser, admin);
  await openChannel(me, priv.name);

  const t1 = "alpha bravo charlie delta echo foxtrot";
  const t2 = "golf hotel india juliet kilo lima";
  await send(me, priv.name, t1);
  await send(me, priv.name, t2);

  const b1 = await messageRow(me, t1).getByText(t1, { exact: true }).boundingBox();
  const b2 = await messageRow(me, t2).getByText(t2, { exact: true }).boundingBox();
  const debut = milieu(b1, 1);
  const fin = milieu(b2, 130);
  await surveillerMenuNatif(me);

  // Glissé vers le bas : la sélection commence dans le message du haut, et le
  // clic droit tombe sur celui du bas.
  await glisser(me, debut, fin);
  // Ni les boutons de la barre d'actions ni l'heure masquée d'un message groupé.
  expect(await selection(me)).toMatch(/^alpha bravo charlie delta echo foxtrot\s+golf/);
  await clicDroit(me, milieu(b2, 40));
  expect(await menuNatifBloque(me)).toBe(false);
  await expect(menuAuCurseur(messageRow(me, t2))).toHaveCount(0);

  // Glissé vers le haut : l'inverse.
  await me.evaluate(() => window.getSelection().removeAllRanges());
  await glisser(me, fin, debut);
  await clicDroit(me, milieu(b1, 40));
  expect(await menuNatifBloque(me)).toBe(false);
  await expect(menuAuCurseur(messageRow(me, t1))).toHaveCount(0);
});

test("clic droit sur un lien : le menu du navigateur reste disponible", async ({
  browser,
  request,
}) => {
  const { admin, priv } = await setup(request);
  const me = await openAs(browser, admin);
  await openChannel(me, priv.name);

  const composer = me.getByPlaceholder(`Message dans #${priv.name}`);
  await composer.fill("[un lien](https://example.com/page)");
  await composer.press("Enter");
  const lien = chat(me).getByRole("link", { name: "un lien" });
  await expect(lien).toBeVisible();

  await surveillerMenuNatif(me);
  await lien.click({ button: "right" });

  expect(await menuNatifBloque(me)).toBe(false);
  await expect(chat(me).locator("div.fixed").filter({ has: me.getByRole("button") })).toHaveCount(0);
});
