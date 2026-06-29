import { test, expect, devices } from "@playwright/test";

// Full web journey with invitation-based registration. Requires a FRESH isolated
// stack (empty DB) so the first account bootstraps as admin. See TESTING.md.

const tag = () => `e2e_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;
const API_URL = process.env.E2E_API_URL || "http://localhost:4001";

// Reset the shared e2e DB to a virgin state before each attempt so this spec
// bootstraps its own admin regardless of test order or retries (another spec may
// have consumed the one-time bootstrap first). POST /test/reset is gated behind
// E2E_TEST_MODE in docker-compose.e2e.yml; a 404 (stack without it) is tolerated.
test.beforeEach(async ({ request }) => {
  // Node-side request: force IPv4 (Windows resolves "localhost" to ::1, where the
  // IPv4-bound server refuses the connection; Linux/CI is unaffected).
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

// First account: no invitation code -> server bootstraps it as admin.
// We use the always-present "J'ai une invitation" switcher to reach the
// register form, then submit with an empty code field — the server treats
// that as the bootstrap path when the DB is empty. This avoids racing the
// async /health probe that toggles the needsBootstrap banner.
async function bootstrapAdmin(page) {
  const t = tag();
  await page.goto("/");
  await configureServer(page);
  // Two routes to the register form depending on whether the (async) /health
  // probe has flipped `needsBootstrap` yet — the bootstrap banner CTA or the
  // always-present "J'ai une invitation" switcher. Try both.
  const banner = page.getByRole("button", { name: "Créer le compte admin" });
  const inviteLink = page.getByRole("button", { name: /j'ai une invitation/i });
  if (await banner.count()) await banner.first().click();
  else await inviteLink.click();
  await expect(page.getByPlaceholder("Nom affiché")).toBeVisible();
  await page.getByPlaceholder("Nom affiché").fill(`Admin ${t}`);
  await page.getByPlaceholder("Nom d'utilisateur").fill(t);
  await page.getByPlaceholder("Email").fill(`${t}@e2e.local`);
  await page.getByPlaceholder("Mot de passe").fill("test1234");
  // Submit label depends on needsBootstrap: "Créer le compte admin" when set,
  // "S'inscrire" otherwise. The two are mutually exclusive in render.
  const submit = page.getByRole("button", { name: "Créer le compte admin", exact: true });
  if (await submit.count()) await submit.click();
  else await page.getByRole("button", { name: "S'inscrire", exact: true }).click();
  await expect(page.getByRole("button", { name: /Général/ })).toBeVisible();
  return t;
}

// Admin invites an email via the modal; returns the invitation code shown.
async function inviteViaModal(page, adminTag, email) {
  await page.getByRole("button", { name: new RegExp(`Admin ${adminTag}`) }).click();
  await page.getByRole("button", { name: "Inviter un utilisateur" }).click();
  await expect(page.getByText("Inviter un utilisateur")).toBeVisible();
  await page.getByPlaceholder("email@exemple.fr").fill(email);
  await page.getByRole("button", { name: "Inviter" }).click();
  const code = (await page.locator("span.font-mono").first().innerText()).trim();
  expect(code.length).toBeGreaterThan(10);
  await page.getByRole("button", { name: "Fermer" }).click();
  return code;
}

async function logout(page) {
  await page.getByRole("button", { name: /Admin / }).click();
  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await expect(page.getByPlaceholder("email ou nom d'utilisateur")).toBeVisible();
}

// Register an invited user with the code (email is prefilled from the invitation).
async function registerWithCode(page, code, email) {
  const t = tag();
  await page.getByRole("button", { name: /s'inscrire/i }).click();
  await page.getByPlaceholder("Code d'invitation").fill(code);
  await expect(page.getByText(new RegExp(`Invitation valide pour ${email}`))).toBeVisible();
  await page.getByPlaceholder("Nom affiché").fill(`E2E ${t}`);
  await page.getByPlaceholder("Nom d'utilisateur").fill(t);
  await page.getByPlaceholder("Mot de passe").fill("test1234");
  await page.getByRole("button", { name: "S'inscrire", exact: true }).click();
  await expect(page.getByRole("button", { name: /Général/ })).toBeVisible();
  return t;
}

async function createPrivateChannel(page, name) {
  // Unified search ("quick switcher"): type the name, then pick the
  // "Créer le salon « … »" action, which opens the create form pre-filled.
  await page.getByPlaceholder(/Rechercher ou créer/).fill(name);
  await page.getByRole("button", { name: /Créer le salon/ }).click();
  await expect(page.getByText("Créer une conversation")).toBeVisible();
  // Name is pre-filled from the search; re-assert it, then mark the channel private.
  await page.getByPlaceholder("Nom du salon (ex. marketing)").fill(name);
  await page.getByText("Salon privé").click();
  await page.getByRole("button", { name: "Créer" }).click();
  await expect(page.getByText("Créer une conversation")).toBeHidden();
}

const messageRow = (page, text) =>
  page.locator("div.group").filter({ hasText: text }).last();

test("invitation registration + full web journey", async ({ page, browser }) => {
  page.on("dialog", (d) => d.accept());

  // Bootstrap admin, invite a user, capture the code, log out.
  const adminTag = await bootstrapAdmin(page);
  const inviteeEmail = `invitee_${Date.now().toString(36)}@e2e.local`;
  const code = await inviteViaModal(page, adminTag, inviteeEmail);
  await logout(page);

  // The invited user registers with the code (email prefilled).
  const userTag = await registerWithCode(page, code, inviteeEmail);

  // Channel + message lifecycle as the invited user.
  const channel = `e2e-${Date.now().toString(36)}`;
  await createPrivateChannel(page, channel);

  const composer = page.getByPlaceholder(`Message dans #${channel}`);

  // Régression #102 : le déclencheur de pièce jointe (« Clippy ») doit être
  // visible pour tout le monde. Il s'appuie sur un SVG inline et non sur
  // l'emoji 📎, qui ne s'affiche pas sur toutes les plateformes (Linux/Chrome
  // sans police emoji couleur le rend en « tofu », d'où un bouton invisible).
  const attachBtn = page.getByTitle("Joindre un fichier");
  await expect(attachBtn).toBeVisible();
  await expect(attachBtn.locator("svg")).toBeVisible();
  // Issues #98 et #113 : l'icône doit être la mascotte « Clippy » (trombone +
  // visage), pas un trombone générique. Le visage comporte deux yeux globuleux
  // (contour + pupille → 4 <circle>) que l'on vérifie ici comme garde-fou.
  await expect(attachBtn.locator("svg circle").first()).toBeVisible();
  expect(await attachBtn.locator("svg circle").count()).toBeGreaterThanOrEqual(4);

  // Issue #91 : glisser-déposer un fichier sur la zone de chat. Un dragenter
  // porteur de fichiers affiche l'overlay « Déposez ici », et le drop ingère le
  // fichier (chip visible dans le composer) tout en masquant l'overlay.
  const chat = page
    .locator("section")
    .filter({ has: page.getByPlaceholder(`Message dans #${channel}`) });
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["bonjour drop"], "drop-test.txt", { type: "text/plain" }));
    return dt;
  });
  await chat.dispatchEvent("dragenter", { dataTransfer });
  await expect(page.getByText("Déposez ici pour envoyer")).toBeVisible();
  await chat.dispatchEvent("drop", { dataTransfer });
  await expect(page.getByText("Déposez ici pour envoyer")).toBeHidden();
  await expect(page.getByText("drop-test.txt")).toBeVisible();
  // On retire la pièce jointe déposée pour ne pas polluer la suite du parcours.
  await chat.getByRole("button", { name: "✕" }).click();
  await expect(page.getByText("drop-test.txt")).toBeHidden();

  await composer.fill("hello e2e");
  await composer.press("Enter");
  await expect(page.getByText("hello e2e")).toBeVisible();

  const row = messageRow(page, "hello e2e");
  await row.hover();
  await row.getByRole("button", { name: "Modifier" }).click();
  const editor = page.locator("textarea:focus");
  await editor.fill("hello edited");
  await editor.press("Enter");
  await expect(page.getByText("hello edited")).toBeVisible();
  await expect(page.getByText("(modifié)")).toBeVisible();

  // Inline reply (Discord-style): clicking "Répondre" shows a quote banner
  // above the main composer, then the reply lands in the same timeline with
  // a clickable quote bubble of the parent.
  const editedRow = messageRow(page, "hello edited");
  await editedRow.hover();
  await editedRow.getByRole("button", { name: "Répondre" }).click();
  await expect(page.getByText("↩ Réponse à")).toBeVisible();
  await composer.fill("ma réponse");
  await composer.press("Enter");
  await expect(page.getByText("ma réponse")).toBeVisible();
  // The quote banner above the composer goes away once the reply is sent.
  await expect(page.getByText("↩ Réponse à")).toBeHidden();

  // Markdown rendering: a message with inline markdown renders real elements
  // (not literal asterisks/backticks).
  await composer.fill("du **gras** et du `code`");
  await composer.press("Enter");
  const mdRow = messageRow(page, "gras");
  await expect(mdRow.locator("strong", { hasText: "gras" })).toBeVisible();
  await expect(mdRow.locator("code", { hasText: "code" })).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: new RegExp(channel) }).click();
  // After the reload there are 2 "hello edited" on screen: the original
  // message and the quote bubble inside our reply. .first() targets the
  // original (the topmost in the timeline).
  await expect(page.getByText("hello edited").first()).toBeVisible();
  // Markdown survives a reload (re-parsed from the stored source).
  await expect(messageRow(page, "gras").locator("strong")).toBeVisible();

  // Issue #124 : transférer un message vers une autre conversation. On envoie un
  // message dédié, on ouvre son menu d'action, on choisit « Transférer » puis le
  // salon « Général » dans la modale ; on bascule alors sur la cible où le
  // message transféré apparaît avec sa mention d'origine et le texte cité.
  await composer.fill("message a transferer");
  await composer.press("Enter");
  const toForward = messageRow(page, "message a transferer");
  await toForward.hover();
  await toForward.getByRole("button", { name: "Transférer" }).click();
  const forwardDialog = page.getByRole("dialog", { name: "Transférer le message" });
  await expect(forwardDialog).toBeVisible();
  await forwardDialog.getByRole("button", { name: /Général/ }).click();
  await expect(forwardDialog).toBeHidden();
  // La cible reçoit le message transféré (attribution + texte d'origine cité).
  await expect(page.getByText(/Message transféré de/)).toBeVisible();
  await expect(
    messageRow(page, "Message transféré de").locator("blockquote")
  ).toContainText("message a transferer");
  // On revient sur le salon d'origine pour ne pas perturber la suite du parcours.
  await page.getByRole("button", { name: new RegExp(channel) }).click();

  // Issue #135 : autocomplétion des mentions. Dans « Général » (admin + invité
  // sont tous deux membres du salon par défaut), taper « @ » suivi d'un préfixe
  // propose les autres membres ; choisir une entrée insère « @username », la
  // forme « @pseudo » reconnue côté serveur (isMentioned) pour les notifications.
  await page.getByRole("button", { name: /Général/ }).click();
  const generalComposer = page.getByPlaceholder("Message dans #Général");
  await generalComposer.click();
  await generalComposer.pressSequentially("salut @adm");
  // La liste propose l'admin (nom affiché « Admin … » + @username sous-titré).
  const mentionOption = page.getByRole("button", {
    name: new RegExp(`Admin ${adminTag}`),
  });
  await expect(mentionOption).toBeVisible();
  await mentionOption.click();
  // Le composer contient désormais la mention au format @username (suivie d'une
  // espace), prête à être complétée.
  await expect(generalComposer).toHaveValue(new RegExp(`@${adminTag}\\s`));
  await generalComposer.press("Enter");
  await expect(messageRow(page, `@${adminTag}`)).toBeVisible();

  // Issue #94 : la recherche de la barre latérale doit être pilotable au clavier.
  // On tape une requête, on bouge la sélection avec les flèches (bas puis haut,
  // ce qui ramène sur le premier résultat « Général ») et on valide avec Entrée :
  // la conversation surlignée doit s'ouvrir sans le moindre clic souris.
  const search = page.getByPlaceholder(/Rechercher ou créer/);
  await search.fill("Général");
  await expect(page.getByText("Vos conversations")).toBeVisible();
  await search.press("ArrowDown");
  await search.press("ArrowUp");
  await search.press("Enter");
  await expect(page.getByPlaceholder("Message dans #Général")).toBeVisible();
  // La validation au clavier vide aussi le champ de recherche.
  await expect(search).toHaveValue("");
  // On revient sur le salon d'origine pour la suite du parcours.
  await page.getByRole("button", { name: new RegExp(channel) }).click();

  // Issue #118 : la popup « Signaler un bug » doit expliquer son fonctionnement
  // — un agent IA traite d'abord la demande, puis le support la valide — pour
  // que l'utilisateur ne soit pas laissé sans repère après « Démarrer ».
  await page.getByRole("button", { name: `E2E ${userTag} ▾` }).click();
  await page.getByRole("button", { name: "🐞 Signaler un bug" }).click();
  await expect(page.getByText("🐞 Signaler un bug")).toBeVisible();
  await expect(page.getByText(/assistant IA échange avec vous/)).toBeVisible();
  await expect(page.getByText(/équipe de support, qui le valide/)).toBeVisible();

  // Issue #133 : sur tactile (PWA mobile, pointeur « coarse »), la touche
  // « Entrée » doit insérer un saut de ligne et NON envoyer le message — l'envoi
  // reste assuré par le bouton « Envoyer » dédié, conformément aux conventions
  // mobiles et pour éviter les envois accidentels. On rejoue le même utilisateur
  // dans un contexte mobile émulé pour valider le comportement de bout en bout.
  const mobileCtx = await browser.newContext({ ...devices["Pixel 7"] });
  const mob = await mobileCtx.newPage();
  mob.on("dialog", (d) => d.accept());
  await mob.goto("/");
  await configureServer(mob);
  await mob.getByPlaceholder("email ou nom d'utilisateur").fill(userTag);
  await mob.getByPlaceholder("Mot de passe").fill("test1234");
  await mob.getByRole("button", { name: "Se connecter", exact: true }).click();
  // Garde-fou : l'émulation mobile expose bien un pointeur tactile « coarse »,
  // signal sur lequel s'appuie le composer pour basculer Entrée → saut de ligne.
  expect(await mob.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  // Mise en page mono-panneau sur mobile : au login l'app ouvre directement un
  // salon (le dernier/le premier), donc le composer est déjà accessible. On le
  // cible de façon générique, le comportement testé étant indépendant du salon.
  const mobComposer = mob.getByPlaceholder(/^Message dans #/);
  await expect(mobComposer).toBeVisible();
  await mobComposer.click();
  await mobComposer.pressSequentially("ligne un");
  await mobComposer.press("Enter");
  await mobComposer.pressSequentially("ligne deux");
  // Entrée n'a pas envoyé : le texte (avec saut de ligne) reste dans le composer
  // et aucun message « ligne un » n'a été posté dans le fil.
  await expect(mobComposer).toHaveValue("ligne un\nligne deux");
  await expect(mob.getByText("ligne un", { exact: true })).toHaveCount(0);
  // En revanche, le bouton « Envoyer » poste bien le message multi-lignes.
  await mob.getByRole("button", { name: "Envoyer" }).click();
  await expect(mobComposer).toHaveValue("");
  await expect(mob.getByText("ligne deux")).toBeVisible();
  await mobileCtx.close();
});
