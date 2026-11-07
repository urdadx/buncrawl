import { NodeHtmlMarkdown } from "node-html-markdown";

// node-html-markdown converts roughly 2.7x faster than turndown on real pages and turns layout
// tables into Markdown instead of passing them through as raw HTML.
const converter = new NodeHtmlMarkdown(
  {
    bulletMarker: "-",
    // Nested lists need at least the parent marker's width ("1. " is 3) to stay nested.
    indent: "    ",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    strongDelimiter: "**",
    useInlineLinks: true,
    ignore: ["script", "style", "noscript", "iframe", "svg", "canvas", "template"],
  },
  {
    // A fence must be longer than any backtick run inside the code, or the block ends early.
    pre: ({ node }) => {
      const code = (node.textContent ?? "").replace(/\n$/, "");
      const longestFence = Math.max(
        0,
        ...[...code.matchAll(/`+/g)].map((match) => match[0].length),
      );
      const fence = "`".repeat(Math.max(3, longestFence + 1));
      return {
        content: code,
        prefix: `${fence}\n`,
        postfix: `\n${fence}`,
        recurse: false,
        noEscape: true,
        preserveWhitespace: true,
        surroundingNewlines: 2,
      };
    },
  },
);

export function htmlToMarkdown(html: string): string {
  return normalizeMarkdown(converter.translate(html));
}

function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/^(\s*[-+*]) {2,}/gm, "$1 ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
