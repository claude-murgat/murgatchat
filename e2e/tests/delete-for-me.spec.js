import { test, expect } from "@playwright/test";

// « Supprimer pour moi » : le message d'un autre membre peut être retiré de son
// propre fil. Il disparaît pour soi seul (y compris après rechargement) et reste
// visible de son auteur ; son propre message garde la suppression pour tous.

const API_URL = process.env.E2E_API_URL || "http://localhost:4001";
// Requêtes côté Node : forcer IPv4 (Windows résout "localhost" en ::1).
const API = API_URL.replace("localhost", "127.0.0.1");
const tag = () => `hide_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

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

// Deux comptes (admin bootstrap + invité) et un salon privé commun.
async function setup(request) {
  const a = tag();
  const admin = await call(request, null, "POST", "/auth/register", {
    email: `${a}@e2e.local`,
    username: a,
    displayName: `Admin ${a}`,
    password: "test1234",
  });
  const b = tag();
  const { token: invitation } = await call(request, admin.token, "POST", "/auth/invitations", {
    email: `${b}@e2e.local`,
  });
  const peer = await call(request, null, "POST", "/auth/register", {
    email: `${b}@e2e.local`,
    username: b,
    displayName: `Pair ${b}`,
    password: "test1234",
    token: invitation,
  });
  const { channel: priv } = await call(request, admin.token, "POST", "/channels", {
    name: `prive-${a}`,
    isPrivate: true,
    memberIds: [peer.user.id],
  });
  return { admin, peer, priv };
}

// Ouvre l'app déjà connectée : jeton + adresse serveur posés avant le boot.
async function openAs(browser, session) {
  const context = await browser.newContext();
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

test("hides another member's message for me only", async ({ browser, request }) => {
  const { admin, peer, priv } = await setup(request);
  const me = await openAs(browser, admin);
  const other = await openAs(browser, peer);
  await openChannel(me, priv.name);
  await openChannel(other, priv.name);

  await send(other, priv.name, "message de l'autre");
  await send(me, priv.name, "mon message");
  await expect(chat(me).getByText("message de l'autre")).toBeVisible();

  // Son propre message : suppression pour tous, pas « pour moi ».
  const mine = messageRow(me, "mon message");
  await mine.hover();
  await expect(mine.getByRole("button", { name: "Supprimer", exact: true })).toBeVisible();
  await expect(mine.getByRole("button", { name: "Supprimer pour moi" })).toHaveCount(0);

  const theirs = messageRow(me, "message de l'autre");
  await theirs.hover();
  await expect(theirs.getByRole("button", { name: "Modifier" })).toHaveCount(0);
  await theirs.getByRole("button", { name: "Supprimer pour moi" }).click();

  await expect(chat(me).getByText("message de l'autre")).toBeHidden();
  await expect(chat(me).getByText("mon message")).toBeVisible();
  // L'auteur le voit toujours.
  await expect(chat(other).getByText("message de l'autre")).toBeVisible();

  // Masqué durablement : toujours absent après rechargement.
  await me.reload();
  await openChannel(me, priv.name);
  await expect(chat(me).getByText("mon message")).toBeVisible();
  await expect(chat(me).getByText("message de l'autre")).toHaveCount(0);
});
