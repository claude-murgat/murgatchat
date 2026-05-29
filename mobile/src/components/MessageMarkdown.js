import { memo, useMemo } from "react";
import { Linking, Platform } from "react-native";
import Markdown from "react-native-markdown-display";
import { colors } from "../theme";

// GFM-ish rendering for message bodies on mobile (markdown-it under the hood,
// no raw HTML → XSS-safe). Mirrors the web MessageMarkdown component; code
// blocks are styled monospace on a dark background (no per-language syntax
// coloring on mobile — the library doesn't do it and it's not worth the weight).
const mono = Platform.OS === "ios" ? "Menlo" : "monospace";

function buildStyles() {
  return {
    body: { color: colors.text, fontSize: 15, lineHeight: 20 },
    paragraph: { marginTop: 0, marginBottom: 0, flexWrap: "wrap" },
    link: { color: colors.aubergine, textDecorationLine: "underline" },
    strong: { fontWeight: "700" },
    em: { fontStyle: "italic" },
    s: { textDecorationLine: "line-through" },
    bullet_list: { marginVertical: 2 },
    ordered_list: { marginVertical: 2 },
    list_item: { marginVertical: 1 },
    blockquote: {
      backgroundColor: colors.bg,
      borderLeftColor: colors.border,
      borderLeftWidth: 3,
      paddingHorizontal: 8,
      paddingVertical: 2,
      marginVertical: 2,
    },
    heading1: { fontSize: 18, fontWeight: "700", marginVertical: 2 },
    heading2: { fontSize: 16, fontWeight: "700", marginVertical: 2 },
    heading3: { fontSize: 15, fontWeight: "600", marginVertical: 2 },
    code_inline: {
      backgroundColor: "#EceaEE",
      color: colors.aubergine,
      fontFamily: mono,
      fontSize: 13,
      borderRadius: 4,
      paddingHorizontal: 4,
    },
    code_block: codeBlock(),
    fence: codeBlock(),
    table: { borderWidth: 1, borderColor: colors.border, borderRadius: 4, marginVertical: 2 },
    th: { padding: 5, fontWeight: "700" },
    td: { padding: 5, borderColor: colors.border },
  };
}

function codeBlock() {
  return {
    backgroundColor: "#0F172A", // slate-900, matches web
    color: "#E2E8F0",
    fontFamily: mono,
    fontSize: 13,
    borderRadius: 6,
    padding: 10,
    marginVertical: 2,
  };
}

// Open links in the system browser instead of navigating in-app.
function onLinkPress(url) {
  Linking.openURL(url).catch(() => {});
  return false;
}

function MessageMarkdown({ children }) {
  const styles = useMemo(buildStyles, []);
  return (
    <Markdown style={styles} onLinkPress={onLinkPress}>
      {children || ""}
    </Markdown>
  );
}

export default memo(MessageMarkdown);
