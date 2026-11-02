// Collage riche → Markdown dans les champs de saisie des messages.
//
// Les messages sont du Markdown, rendu en GFM à l'affichage (MessageMarkdown).
// Mais un <textarea> ne reçoit au collage que le texte brut du presse-papier, et
// Chromium (donc aussi WebView2 dans l'appli de bureau) n'y met pas les puces
// d'une liste : c'est le CSS qui les dessine. Une liste copiée depuis une réponse
// de Claude, un Google Docs, Word ou un mail arrivait donc à plat, sans puces ni
// retrait, et perdait au passage le gras et le code.
//
// Au collage, on relit la version HTML du presse-papier et on la traduit en
// Markdown : listes (imbriquées, numérotées, y compris les fausses listes de
// Word), gras, italique, barré, code, liens, titres, citations, blocs de code et
// tableaux. On laisse faire le collage natif, comme avant :
//  - quand le HTML n'apporte aucune mise en forme ;
//  - quand le résultat tient sur une ligne : quelques mots copiés dans un titre
//    ou un élément de liste restent du texte, sans « ## » ni « - » ;
//  - dans un bloc de code ``` en cours de saisie.
// Ctrl+Maj+V colle toujours le texte brut : le navigateur ne fournit alors que lui.
import type { ClipboardEvent } from "react";

type Space = "normal" | "pre-line" | "pre";

/** Contexte hérité pendant le parcours du HTML collé. */
interface Ctx {
  space: Space;
  bold: boolean;
  italic: boolean;
  strike: boolean;
}

interface ListBlock {
  kind: "list";
  ordered: boolean;
  start: number;
  items: Block[][];
}

type Block =
  | { kind: "para"; text: string }
  // Ligne vide voulue (paragraphe vide de Word, <div><br></div> de Gmail…).
  | { kind: "blank" }
  | { kind: "heading"; level: number; text: string }
  | ListBlock
  | { kind: "quote"; blocks: Block[] }
  | { kind: "code"; text: string; lang: string }
  | { kind: "table"; rows: string[][] }
  | { kind: "rule" };

const ROOT: Ctx = { space: "normal", bold: false, italic: false, strike: false };

// Éléments dont le contenu n'est pas du texte à coller (boutons « Copier » des
// blocs de code, formulaires, médias…). <img> et <input> sont traités à part.
const SKIP = new Set([
  "head", "title", "meta", "link", "style", "script", "template", "noscript",
  "button", "select", "option", "textarea", "svg", "math", "canvas", "video",
  "audio", "iframe", "object", "embed", "picture", "source", "map", "area",
]);

const BLOCKS = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "center",
  "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hgroup", "hr", "html", "li", "main", "menu", "nav", "ol", "p",
  "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead",
  "tr", "ul",
]);
const BLOCK_SELECTOR = Array.from(BLOCKS).join(",");

const PRE_TAGS = new Set(["pre", "listing", "xmp", "plaintext"]);
const CODE_TAGS = new Set(["code", "kbd", "samp", "tt"]);

// Paragraphe d'une liste Word/Outlook : Word n'écrit pas de <ul>/<li> mais des
// <p style="mso-list:l0 level2 lfo1">, la puce étant un <span mso-list:Ignore>.
const WORD_LIST = /mso-list:\s*(l\d+)\s+level(\d+)/i;

function styleOf(el: Element, prop: string): string | undefined {
  const style = el.getAttribute("style");
  if (!style) return undefined;
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec(style);
  return m?.[1].replace(/!important/i, "").trim().toLowerCase();
}

function skipped(el: Element): boolean {
  if (SKIP.has(el.localName) || el.hasAttribute("hidden")) return true;
  // Retour à la ligne que Chromium et WebKit ajoutent en bord de sélection.
  if (el.localName === "br" && el.classList.contains("Apple-interchange-newline")) return true;
  const style = el.getAttribute("style");
  return !!style && /display\s*:\s*none|mso-list\s*:\s*ignore|mso-hide\s*:\s*all/i.test(style);
}

function whiteSpace(el: Element, inherited: Space): Space {
  if (PRE_TAGS.has(el.localName)) return "pre";
  const ws = styleOf(el, "white-space");
  if (!ws) return inherited;
  if (ws.startsWith("pre-line")) return "pre-line";
  if (ws.startsWith("pre") || ws === "break-spaces") return "pre";
  if (ws === "normal" || ws === "nowrap") return "normal";
  return inherited;
}

function collapse(text: string, space: Space): string {
  if (space === "pre") return text.replace(/\r\n?/g, "\n");
  if (space === "pre-line") return text.replace(/\r\n?/g, "\n").replace(/[ \t\f]+/g, " ");
  return text.replace(/[ \t\n\r\f]+/g, " ");
}

function isBold(el: Element): boolean {
  const weight = styleOf(el, "font-weight");
  const n = Number(weight);
  // Google Docs enveloppe tout le collage dans <b style="font-weight:normal">.
  if (el.localName === "b" || el.localName === "strong") {
    return !(weight === "normal" || weight === "lighter" || (n > 0 && n < 500));
  }
  return weight === "bold" || weight === "bolder" || n >= 700;
}

function isItalic(el: Element): boolean {
  const style = styleOf(el, "font-style");
  if (el.localName === "i" || el.localName === "em") return style !== "normal";
  return style === "italic" || style === "oblique";
}

function isStruck(el: Element): boolean {
  const deco = styleOf(el, "text-decoration-line") ?? styleOf(el, "text-decoration");
  if (["s", "strike", "del"].includes(el.localName)) return !deco?.includes("none");
  return !!deco?.includes("line-through");
}

/** Entoure `inner` d'un marqueur, en laissant les espaces de bord à l'extérieur. */
function wrap(inner: string, marker: string): string {
  // Ligne par ligne : une emphase ne survit pas à un saut de paragraphe.
  return inner
    .split("\n")
    .map((line) => {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(line)!;
      return m[2] ? `${m[1]}${marker}${m[2]}${marker}${m[3]}` : line;
    })
    .join("\n");
}

function codeSpan(text: string): string {
  const code = text.replace(/\s+/g, " ");
  if (!code.trim()) return code;
  const longest = Math.max(0, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${ticks}${pad}${code}${pad}${ticks}`;
}

/** Texte d'un <pre> : les sauts de ligne viennent du texte, des <br> et des blocs. */
function preText(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.nodeValue ?? "";
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      if (skipped(el)) continue;
      if (el.localName === "br") {
        out += "\n";
        continue;
      }
      const block = BLOCKS.has(el.localName);
      if (block && out && !out.endsWith("\n")) out += "\n";
      out += preText(el);
      if (block && !out.endsWith("\n")) out += "\n";
    }
  }
  return out.replace(/\r\n?/g, "\n");
}

function cleanLine(line: string): string {
  return line
    .replace(/ {2,}/g, " ")
    .replace(/^[ \u00a0]+|[ \u00a0]+$/g, "")
    .replace(/\u00a0/g, " ");
}

/** Accumule le texte en ligne d'un paragraphe et la suite des blocs produits. */
class Sink {
  blocks: Block[] = [];
  private buf = "";

  text(s: string) {
    this.buf += s;
  }

  push(block: Block) {
    this.flush();
    this.blocks.push(block);
  }

  flush() {
    const raw = this.buf;
    this.buf = "";
    // Comme à l'écran : pas de ligne vide en bord de paragraphe (un <br> final
    // ne crée pas de ligne), et jamais plus d'une ligne vide d'affilée.
    const text = raw
      .split("\n")
      .map(cleanLine)
      .join("\n")
      .replace(/^\n+|\n+$/g, "")
      .replace(/\n{3,}/g, "\n\n");
    if (text) this.blocks.push({ kind: "para", text });
    else if (/[\n\u00a0]/.test(raw)) this.blocks.push({ kind: "blank" });
  }
}

class Converter {
  /** Une mise en forme en ligne (gras, code, lien…) a été produite. */
  formatted = false;

  blocks(node: Node, ctx: Ctx): Block[] {
    const sink = new Sink();
    this.children(node, ctx, sink);
    sink.flush();
    return sink.blocks;
  }

  private blocksOfNode(node: Node, ctx: Ctx): Block[] {
    const sink = new Sink();
    this.node(node, ctx, sink);
    sink.flush();
    return sink.blocks;
  }

  private children(parent: Node, ctx: Ctx, sink: Sink) {
    const kids = Array.from(parent.childNodes);
    for (let i = 0; i < kids.length; i++) {
      if (!wordList(kids[i])) {
        this.node(kids[i], ctx, sink);
        continue;
      }
      // Paragraphes de liste Word consécutifs (blancs et commentaires
      // conditionnels entre eux ignorés) : ils forment une seule liste.
      const run: Element[] = [];
      while (i < kids.length && (wordList(kids[i]) || isBlankNode(kids[i]))) {
        if (wordList(kids[i])) run.push(kids[i] as Element);
        i++;
      }
      i--;
      for (const list of this.wordLists(run, ctx)) sink.push(list);
    }
  }

  private node(node: Node, ctx: Ctx, sink: Sink) {
    if (node.nodeType === Node.TEXT_NODE) {
      sink.text(collapse(node.nodeValue ?? "", ctx.space));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (skipped(el)) return;
    const tag = el.localName;
    const inner: Ctx = { ...ctx, space: whiteSpace(el, ctx.space) };
    switch (tag) {
      case "ul":
      case "ol":
        sink.push(this.list(el, inner));
        return;
      case "li":
        // <li> hors liste : on lui rend sa puce.
        sink.push({ kind: "list", ordered: false, start: 1, items: [this.blocks(el, inner)] });
        return;
      case "pre": {
        const code = this.code(el);
        if (code.text) sink.push(code);
        return;
      }
      case "blockquote":
        sink.push({ kind: "quote", blocks: this.blocks(el, inner) });
        return;
      case "hr":
        sink.push({ kind: "rule" });
        return;
      case "table":
        this.table(el, inner, sink);
        return;
    }
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      const text = this.flatText(el, { ...inner, bold: true });
      if (text) sink.push({ kind: "heading", level: Number(heading[1]), text });
      return;
    }
    if (BLOCKS.has(tag)) {
      sink.flush();
      this.children(el, inner, sink);
      sink.flush();
      return;
    }
    // Élément en ligne qui contient des blocs (Google Docs enveloppe tout dans
    // un <b>) : on le traverse sans appliquer sa mise en forme.
    if (el.querySelector(BLOCK_SELECTOR)) {
      this.children(el, inner, sink);
      return;
    }
    sink.text(this.inline(el, ctx));
  }

  /** Markdown d'un élément en ligne, qui ne contient aucun bloc. */
  private inline(node: Node, ctx: Ctx): string {
    if (node.nodeType === Node.TEXT_NODE) return collapse(node.nodeValue ?? "", ctx.space);
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    if (skipped(el)) return "";
    const tag = el.localName;
    if (tag === "br") return "\n";
    if (tag === "img") return emojiAlt(el);
    if (tag === "input") {
      if (el.getAttribute("type")?.toLowerCase() !== "checkbox") return "";
      return el.hasAttribute("checked") ? "[x] " : "[ ] ";
    }
    if (CODE_TAGS.has(tag)) {
      const code = codeSpan(el.textContent ?? "");
      if (code.trim()) this.formatted = true;
      return code;
    }
    const bold = !ctx.bold && isBold(el);
    const italic = !ctx.italic && isItalic(el);
    const strike = !ctx.strike && isStruck(el);
    const next: Ctx = {
      space: whiteSpace(el, ctx.space),
      bold: ctx.bold || bold,
      italic: ctx.italic || italic,
      strike: ctx.strike || strike,
    };
    let out = Array.from(el.childNodes, (child) => this.inline(child, next)).join("");
    if (tag === "a") out = this.link(el, out);
    if (!out.trim()) return out;
    if (strike) out = wrap(out, "~~");
    if (italic) out = wrap(out, "*");
    if (bold) out = wrap(out, "**");
    if (bold || italic || strike) this.formatted = true;
    return out;
  }

  private link(el: Element, inner: string): string {
    const href = (el.getAttribute("href") ?? "").trim();
    if (!/^(https?:\/\/|mailto:)/i.test(href)) return inner;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
    const text = m[2];
    if (!text || text.includes("\n")) return inner;
    // Une adresse affichée telle quelle reste nue : le GFM la rend cliquable.
    const bare = href.replace(/^mailto:/i, "");
    if (text === href || text === bare || (text.startsWith("www.") && href.endsWith(`//${text}`)))
      return inner;
    this.formatted = true;
    const dest = href.replace(/\s/g, "%20");
    return `${m[1]}[${text}](${/[()<>]/.test(dest) ? `<${dest.replace(/[<>]/g, encodeURIComponent)}>` : dest})${m[3]}`;
  }

  /** Texte des paragraphes d'un élément, sur une seule ligne (titre, cellule). */
  private flatText(el: Element, ctx: Ctx): string {
    return this.blocks(el, ctx)
      .map((b) => (b.kind === "para" ? b.text.replace(/\n/g, " ") : ""))
      .filter(Boolean)
      .join(" ");
  }

  private list(el: Element, ctx: Ctx): ListBlock {
    const ordered = el.localName === "ol";
    const start = Number.parseInt(el.getAttribute("start") ?? "", 10);
    const items: Block[][] = [];
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE && (child as Element).localName === "li") {
        if (!skipped(child as Element)) items.push(this.blocks(child, ctx));
        continue;
      }
      // Google Docs range la sous-liste à côté des <li>, pas dedans : on la
      // rattache à l'élément qui la précède.
      const extra = this.blocksOfNode(child, ctx);
      if (!extra.length) continue;
      if (items.length) items[items.length - 1].push(...extra);
      else items.push(extra);
    }
    return {
      kind: "list",
      ordered,
      start: ordered && Number.isFinite(start) ? start : 1,
      items: items.filter((item) => item.some((b) => b.kind !== "blank")),
    };
  }

  private wordLists(run: Element[], ctx: Ctx): ListBlock[] {
    const roots: ListBlock[] = [];
    const stack: { list: ListBlock; level: number; id: string }[] = [];
    for (const p of run) {
      const { id, level } = wordList(p)!;
      const marker = wordMarker(p);
      // « 1. », « a) », « iv. », « 1.2. »… numérotent ; « · », « o », « § » sont des puces.
      const ordered = /^\(?(?:(?:\d+[.)])+|[a-z]{1,4}[.)])$/i.test(marker);
      while (stack.length && stack[stack.length - 1].level > level) stack.pop();
      // Au même niveau, une autre liste Word (lN) ou un autre type de puce
      // ouvre une nouvelle liste.
      const same = stack[stack.length - 1];
      if (same?.level === level && (same.id !== id || same.list.ordered !== ordered)) stack.pop();
      let top = stack[stack.length - 1];
      if (!top || top.level < level) {
        const list: ListBlock = {
          kind: "list",
          ordered,
          start: Number(/(\d+)[.)]$/.exec(marker)?.[1] ?? 1),
          items: [],
        };
        if (top) top.list.items[top.list.items.length - 1].push(list);
        else roots.push(list);
        top = { list, level, id };
        stack.push(top);
      }
      top.list.items.push(this.blocks(p, ctx));
    }
    return roots;
  }

  private code(el: Element): Extract<Block, { kind: "code" }> {
    const text = preText(el).replace(/\u00a0/g, " ").replace(/^\n+|\s+$/g, "");
    const classes = `${el.className} ${el.querySelector("code")?.className ?? ""}`;
    const lang = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(classes)?.[1] ?? "";
    return { kind: "code", text, lang };
  }

  private table(el: Element, ctx: Ctx, sink: Sink) {
    const rows = Array.from((el as HTMLTableElement).rows, (row) =>
      Array.from(row.cells, (cell) =>
        this.blocks(cell, { ...ctx, bold: ctx.bold || cell.localName === "th" })
      )
    );
    const width = Math.max(0, ...rows.map((r) => r.length));
    // Tableau de données (Excel, Sheets, Claude) : au moins 2×2, sans tableau
    // imbriqué, une ligne de texte par cellule. Sinon c'est de la mise en page
    // (mails, signatures) : on garde seulement le contenu des cellules.
    const data =
      rows.length >= 2 &&
      width >= 2 &&
      !el.querySelector("table") &&
      rows.every((r) => r.every((c) => c.every((b) => b.kind === "para" || b.kind === "blank")));
    if (!data) {
      for (const block of rows.flat(2)) sink.push(block);
      return;
    }
    sink.push({
      kind: "table",
      rows: rows.map((r) =>
        r.map((c) =>
          c
            .map((b) => (b.kind === "para" ? b.text.replace(/\n/g, " ") : ""))
            .filter(Boolean)
            .join(" ")
        )
      ),
    });
  }
}

function wordList(node: Node): { id: string; level: number } | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const m = WORD_LIST.exec(el.getAttribute("style") ?? "");
  // Outlook écrit parfois de vrais <li> avec ce style : ils restent des <li>.
  if (!m || el.closest("li")) return null;
  return { id: m[1].toLowerCase(), level: Number(m[2]) };
}

function wordMarker(p: Element): string {
  const span = Array.from(p.querySelectorAll("[style]")).find((s) =>
    /mso-list\s*:\s*ignore/i.test(s.getAttribute("style") ?? "")
  );
  return (span?.textContent ?? "").replace(/\s/g, "");
}

function isBlankNode(node: Node): boolean {
  if (node.nodeType === Node.COMMENT_NODE) return true;
  return node.nodeType === Node.TEXT_NODE && !/[^ \t\n\r\f]/.test(node.nodeValue ?? "");
}

// Teams, Outlook ou Slack copient leurs emojis en <img alt="😀"> : on garde
// l'emoji, pas les autres images (logos, photos), absentes du texte brut aussi.
function emojiAlt(el: Element): string {
  const alt = el.getAttribute("alt") ?? "";
  return alt.length <= 16 && /\p{Extended_Pictographic}/u.test(alt) && !/[\p{L}\p{N}]/u.test(alt)
    ? alt
    : "";
}

function isSpecial(b: Block): boolean {
  return b.kind !== "para" && b.kind !== "blank";
}

/**
 * Assemble des blocs. Hors liste, deux paragraphes se suivent ligne à ligne
 * (le rendu les affiche pareil) ; les listes, titres, codes, citations et
 * tableaux sont séparés par une ligne vide, sans laquelle le Markdown
 * collerait un paragraphe au dernier élément d'une liste.
 */
function render(blocks: Block[], inItem = false): string {
  let out = "";
  let prev: Block | null = null;
  let blank = false;
  for (const b of blocks) {
    if (b.kind === "blank") {
      blank = true;
      continue;
    }
    const text = renderBlock(b, inItem);
    if (!text) continue;
    if (prev) {
      const tight = inItem
        ? prev.kind === "para" && b.kind === "list"
        : !isSpecial(prev) && !isSpecial(b);
      out += tight && !blank ? "\n" : "\n\n";
    }
    out += text;
    prev = b;
    blank = false;
  }
  return out;
}

function renderBlock(b: Block, inItem: boolean): string {
  switch (b.kind) {
    case "para":
      // Dans un élément de liste, le rendu ne garde pas un simple saut de
      // ligne : on écrit un saut forcé (deux espaces en fin de ligne).
      return inItem ? b.text.replace(/([^\n])\n(?=[^\n])/g, "$1  \n") : b.text;
    case "heading":
      return `${"#".repeat(Math.min(b.level, 3))} ${b.text}`;
    case "list":
      return renderList(b);
    case "quote":
      return render(b.blocks)
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    case "code": {
      const longest = Math.max(2, ...Array.from(b.text.matchAll(/`+/g), (m) => m[0].length));
      const fence = "`".repeat(longest + 1);
      return `${fence}${b.lang}\n${b.text}\n${fence}`;
    }
    case "table": {
      const width = Math.max(...b.rows.map((r) => r.length));
      const line = (r: string[]) =>
        `| ${Array.from({ length: width }, (_, i) => (r[i] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
      return [line(b.rows[0]), `|${" --- |".repeat(width)}`, ...b.rows.slice(1).map(line)].join(
        "\n"
      );
    }
    case "rule":
      return "---";
    case "blank":
      return "";
  }
}

function renderList(list: ListBlock): string {
  return list.items
    .map((item, i) => {
      const marker = list.ordered ? `${list.start + i}. ` : "- ";
      const pad = " ".repeat(marker.length);
      const body = render(item, true);
      return marker + body.split("\n").map((line, j) => (j && line ? pad + line : line)).join("\n");
    })
    .join("\n");
}

/**
 * Markdown équivalent au HTML copié, ou null quand le collage natif fait
 * aussi bien (aucune mise en forme, ou résultat sur une seule ligne).
 */
export function htmlToMarkdown(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const conv = new Converter();
  const blocks = conv.blocks(doc.body, ROOT);
  const content = blocks.filter((b) => b.kind !== "blank");
  if (content.length === 1 && content[0].kind === "code" && !content[0].text.includes("\n")) {
    return null;
  }
  if (!blocks.some(isSpecial) && !conv.formatted) return null;
  const md = render(blocks);
  return md.includes("\n") ? md : null;
}

/** Le curseur est dans un bloc ``` ouvert plus haut et pas encore refermé. */
function insideFence(before: string): boolean {
  return (before.match(/^ {0,3}(?:```|~~~)/gm)?.length ?? 0) % 2 === 1;
}

function insertText(ta: HTMLTextAreaElement, text: string) {
  ta.focus();
  // execCommand est déprécié mais reste le seul moyen d'insérer du texte en
  // gardant l'historique natif : Ctrl+Z annule le collage d'un coup. Il émet
  // aussi l'événement input, donc le onChange de React.
  if (document.execCommand("insertText", false, text)) return;
  ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * onPaste des champs de message : colle la traduction Markdown du HTML copié
 * quand elle apporte quelque chose, sinon laisse faire le navigateur.
 */
export function pasteAsMarkdown(e: ClipboardEvent<HTMLTextAreaElement>): boolean {
  const ta = e.currentTarget;
  if (insideFence(ta.value.slice(0, ta.selectionStart))) return false;
  const html = e.clipboardData?.getData("text/html");
  const md = html ? htmlToMarkdown(html) : null;
  if (md === null) return false;
  e.preventDefault();
  insertText(ta, md);
  return true;
}
