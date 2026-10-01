export function extractLinks(html: string, documentUrl: string): string[] {
  let baseUrl = documentUrl;
  const hrefs: string[] = [];

  new HTMLRewriter()
    .on("base[href]", {
      element(element) {
        if (baseUrl !== documentUrl) return;
        const href = element.getAttribute("href");
        if (!href) return;
        try {
          baseUrl = new URL(href, documentUrl).href;
        } catch {
          // Ignore malformed base elements and resolve against the document URL.
        }
      },
    })
    .on("a[href]", {
      element(element) {
        const href = element.getAttribute("href")?.trim();
        if (href) hrefs.push(href);
      },
    })
    .transform(html);

  const links = new Set<string>();
  for (const href of hrefs) {
    if (href.startsWith("#") || /^(?:javascript|data):/i.test(href)) continue;
    if (/^(?:mailto|tel):/i.test(href)) {
      links.add(href);
      continue;
    }
    try {
      const resolved = new URL(href, baseUrl);
      resolved.hash = "";
      links.add(resolved.href);
    } catch {
      // Malformed links are skipped rather than failing extraction for the page.
    }
  }
  return [...links];
}
