import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

// Convertit les mentions « @pseudo » en tags stylisés (#143). Le Composer insère
// la mention en texte brut (« @username », cf. applyMention) — convention aussi
// reconnue côté serveur (isMentioned) — mais, faute de rendu dédié, elle restait
// affichée en clair après envoi. Ce plugin remark parcourt les nœuds texte du
// mdast et remplace chaque « @pseudo » (en début de texte ou après une espace,
// pour ne pas accrocher les e-mails « a@b ») par un nœud rendu en <span> stylisé.
// Le jeu de caractères suit la règle de validation des usernames ([a-z0-9_.-]).
const MENTION_RE = /(^|\s)@([a-z0-9_.-]+)/gi;

export function remarkMentions() {
  return (tree) => transformMentions(tree);
}

function transformMentions(node) {
  if (!Array.isArray(node.children)) return;
  const next = [];
  for (const child of node.children) {
    if (child.type === "text") {
      next.push(...splitMentions(child.value));
    } else {
      // On ne descend pas dans inlineCode/code : ce sont des nœuds à `value`,
      // sans enfants texte, donc le code littéral reste intact.
      transformMentions(child);
      next.push(child);
    }
  }
  node.children = next;
}

function splitMentions(value) {
  const out = [];
  let last = 0;
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(value))) {
    const [, lead, name] = m;
    const start = m.index + lead.length; // position du « @ »
    if (start > last) out.push({ type: "text", value: value.slice(last, start) });
    out.push(mentionNode(name));
    last = MENTION_RE.lastIndex;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out.length ? out : [{ type: "text", value }];
}

function mentionNode(name) {
  return {
    type: "mention",
    data: {
      hName: "span",
      hProperties: {
        className: [
          "mention",
          "text-aubergine-800",
          "bg-aubergine-700/10",
          "rounded",
          "px-1",
          "font-medium",
        ],
      },
      hChildren: [{ type: "text", value: "@" + name }],
    },
  };
}

// GFM rendering for message bodies. react-markdown does NOT render raw HTML
// (we don't add rehype-raw), so user input can't inject markup — XSS-safe by
// construction. rehype-highlight adds syntax coloring to fenced code blocks.
//
// The component set below scopes Tailwind classes to each element so messages
// stay readable without a global prose stylesheet. Links open in a new tab
// with noopener/noreferrer.
const COMPONENTS = {
  a: ({ node, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className="text-aubergine-700 underline hover:text-aubergine-800"
    />
  ),
  p: ({ node, ...props }) => <p {...props} className="whitespace-pre-wrap break-words" />,
  ul: ({ node, ...props }) => <ul {...props} className="list-disc ml-5 my-1" />,
  ol: ({ node, ...props }) => <ol {...props} className="list-decimal ml-5 my-1" />,
  li: ({ node, ...props }) => <li {...props} className="my-0.5" />,
  blockquote: ({ node, ...props }) => (
    <blockquote
      {...props}
      className="border-l-2 border-slate-300 pl-3 my-1 text-slate-600"
    />
  ),
  h1: ({ node, ...props }) => <h1 {...props} className="text-lg font-bold my-1" />,
  h2: ({ node, ...props }) => <h2 {...props} className="text-base font-bold my-1" />,
  h3: ({ node, ...props }) => <h3 {...props} className="text-base font-semibold my-1" />,
  code: ({ node, inline, className, children, ...props }) =>
    inline ? (
      <code
        {...props}
        className="bg-slate-100 text-aubergine-800 rounded px-1 py-0.5 text-[0.85em] font-mono"
      >
        {children}
      </code>
    ) : (
      // The <pre> wrapper (below) handles the block layout; hljs classes come
      // from rehype-highlight, themed by the .hljs CSS imported in index.css.
      <code {...props} className={className}>
        {children}
      </code>
    ),
  pre: ({ node, ...props }) => (
    <pre
      {...props}
      className="bg-slate-900 text-slate-100 rounded-md p-3 my-1 overflow-x-auto text-[0.85em] font-mono"
    />
  ),
  table: ({ node, ...props }) => (
    <div className="overflow-x-auto my-1">
      <table {...props} className="border-collapse text-sm" />
    </div>
  ),
  th: ({ node, ...props }) => (
    <th {...props} className="border border-slate-300 px-2 py-1 bg-slate-50 font-semibold" />
  ),
  td: ({ node, ...props }) => <td {...props} className="border border-slate-300 px-2 py-1" />,
  // GFM task-list checkboxes — render disabled (display only).
  input: ({ node, ...props }) => <input {...props} disabled className="mr-1" />,
};

function MessageMarkdown({ children }) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMentions]}
        rehypePlugins={[rehypeHighlight]}
        components={COMPONENTS}
      >
        {children || ""}
      </ReactMarkdown>
    </div>
  );
}

// Bodies are immutable per render (edits replace the whole string), so memo
// avoids re-parsing markdown on unrelated parent re-renders.
export default memo(MessageMarkdown);
