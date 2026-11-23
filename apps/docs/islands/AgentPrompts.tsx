import { useEffect, useState } from "react";

import { icons } from "../icons";

// The cards sit near the top of the page, so they work as soon as it loads.
export const client = "load";

/** The setup every agent is asked to do; each agent adds a line about how it runs commands. */
function prompt(howToRun: string): string {
  return `Install Buncrawl, the self-hosted web scraper, by following https://github.com/urdadx/buncrawl#readme.

1. Install it: \`curl -fsSL https://raw.githubusercontent.com/urdadx/buncrawl/main/install.sh | sh\`
2. Check it works: \`buncrawl --version\`
3. Scrape a page and show me the Markdown it prints: \`buncrawl example.com\`

${howToRun}

If I also want the API server, set \`BUNCRAWL_API_KEY\` to a random value of 16 or more characters and start it with \`buncrawl serve\`.`;
}

const agents = [
  {
    name: "Claude Code",
    icon: icons.claudeCode,
    color: "#D97757",
    prompt: prompt(
      "Run the commands yourself with your shell tool, and ask me before anything that needs sudo.",
    ),
  },
  {
    name: "Cursor",
    icon: icons.cursor,
    prompt: prompt("Run the commands in the terminal from agent mode, and show me their output."),
  },
  {
    name: "Codex",
    icon: icons.openai,
    prompt: prompt(
      "The install and the scrape need network access; if your sandbox blocks it, ask me to allow it.",
    ),
  },
  {
    name: "Other agents",
    icon: icons.bot,
    prompt: prompt("Run the commands in a terminal and show me their output."),
  },
];

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  // Pages served over plain HTTP (other than localhost) have no Clipboard API.
  const field = document.createElement("textarea");
  field.value = text;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}

/** One card per coding agent; clicking a card copies that agent's setup prompt. */
export default function AgentPrompts() {
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="not-prose my-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {agents.map((agent) => (
        <button
          key={agent.name}
          type="button"
          onClick={() => void copyText(agent.prompt).then(() => setCopied(agent.name))}
          className="flex cursor-pointer items-center gap-2 overflow-hidden rounded-blume border border-border bg-background px-3 py-3.5 text-left transition-colors hover:border-accent"
        >
          <span
            aria-hidden="true"
            className="inline-flex size-5 shrink-0 [&>svg]:size-full"
            style={{ color: agent.color ?? "currentColor" }}
            dangerouslySetInnerHTML={{ __html: agent.icon }}
          />
          <span className="truncate whitespace-nowrap font-medium text-foreground">
            {copied === agent.name ? "Copied!" : agent.name}
          </span>
        </button>
      ))}
      <span className="sr-only" aria-live="polite">
        {copied ? `${copied} prompt copied` : ""}
      </span>
    </div>
  );
}
