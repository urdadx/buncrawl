import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  fence: "```",
  emDelimiter: "_",
  strongDelimiter: "**",
  linkStyle: "inlined",
});

turndown.use(gfm);
turndown.remove(["script", "style", "noscript", "iframe", "svg", "canvas", "template"]);
turndown.addRule("fenced-preformatted-block", {
  filter: "pre",
  replacement(_content, node) {
    const code = (node.textContent ?? "").replace(/\n$/, "");
    const longestFence = Math.max(0, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
    const fence = "`".repeat(Math.max(3, longestFence + 1));
    return `\n\n${fence}\n${code}\n${fence}\n\n`;
  },
});

export function htmlToMarkdown(html: string): string {
  return normalizeMarkdown(turndown.turndown(html));
}

function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/^(\s*[-+*]) {2,}/gm, "$1 ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
