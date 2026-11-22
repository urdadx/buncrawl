import {
  checkRendererCapabilities,
  setRendererCapabilityReport,
  type RendererCapabilityReport,
} from "@buncrawl/renderer";

/**
 * Checks which browser renderers this host can run and logs the result; HTTP-only scraping works
 * without any. Scrapes and job workers in this process select renderers from the same report.
 */
export function checkRenderers(
  check: () => Promise<RendererCapabilityReport> = checkRendererCapabilities,
): Promise<RendererCapabilityReport> {
  const report = check().then((checked) => {
    for (const renderer of checked.renderers) {
      if (renderer.capabilities.available) {
        console.info(`Renderer ${renderer.name}: ${renderer.version} (${renderer.executable})`);
      } else {
        console.warn(`Renderer ${renderer.name} unavailable: ${renderer.error}`);
      }
    }
    return checked;
  });
  setRendererCapabilityReport(report);
  return report;
}
