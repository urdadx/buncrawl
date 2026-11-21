import { describe, expect, test } from "bun:test";
import { Deadline } from "@buncrawl/core";

import {
  BRANDING_SCRIPT,
  buildBrandingProfile,
  fontStack,
  parseCssColor,
  toHex,
  type BrandingSamples,
} from "../src/branding";
import { RendererChain } from "../src/chain";
import type { Renderer, RenderRequest, RenderResult } from "../src/renderer";

const button = (overrides: Partial<NonNullable<BrandingSamples["buttons"]>[number]>) => ({
  text: "Get started",
  background: "rgb(83, 58, 253)",
  color: "rgb(255, 255, 255)",
  borderColor: "rgb(83, 58, 253)",
  borderWidth: 0,
  borderRadius: "4px",
  shadow: "none",
  inHeader: false,
  top: 400,
  width: 160,
  height: 44,
  ...overrides,
});

const page = (overrides: Partial<BrandingSamples> = {}): BrandingSamples => ({
  url: "https://www.acme.co.uk/pricing",
  title: "Pricing | Acme",
  meta: {},
  root: {
    htmlBackground: "rgba(0, 0, 0, 0)",
    bodyBackground: "rgb(255, 255, 255)",
    color: "rgb(17, 17, 17)",
  },
  fonts: {
    body: { family: "Inter, sans-serif", size: "16px", lineHeight: "24px", weight: 400 },
    h1: { family: '"Playfair Display", serif', size: "48px", lineHeight: "52.8px", weight: 700 },
    code: { family: "ui-monospace, Menlo, monospace", size: "14px" },
  },
  text: [
    {
      family: "Inter, sans-serif",
      size: "16px",
      lineHeight: "24px",
      color: "rgb(17, 17, 17)",
      chars: 2000,
      prose: true,
    },
    {
      family: "Inter, sans-serif",
      size: "14px",
      lineHeight: "20px",
      color: "rgb(107, 114, 128)",
      chars: 400,
      prose: true,
    },
    {
      family: '"Playfair Display", serif',
      size: "48px",
      color: "rgb(17, 17, 17)",
      weight: 700,
      chars: 60,
    },
  ],
  backgrounds: [{ color: "rgb(255, 255, 255)", area: 1_000_000 }],
  spacing: [8, 16, 24, 32, 8, 16, 48, 64, 8, 16, 4],
  links: [{ color: "rgb(14, 165, 233)", chars: 300 }],
  buttons: [
    button({
      text: "Log in",
      background: "rgba(0, 0, 0, 0)",
      color: "rgb(17, 17, 17)",
      inHeader: true,
      top: 10,
      borderWidth: 0,
    }),
    button({}),
    button({
      text: "Contact sales",
      background: "rgba(0, 0, 0, 0)",
      color: "rgb(83, 58, 253)",
      borderWidth: 1,
      borderColor: "rgb(185, 185, 249)",
    }),
  ],
  inputs: [
    {
      background: "rgb(255, 255, 255)",
      color: "rgb(17, 17, 17)",
      borderColor: "rgb(209, 213, 219)",
      borderWidth: 1,
      borderRadius: "6px",
      shadow: "none",
    },
  ],
  logos: [],
  icons: [],
  ...overrides,
});

describe("CSS color parsing", () => {
  test.each([
    ["rgb(83, 58, 253)", "#533AFD", 1],
    ["rgba(0, 0, 0, 0.5)", "#000000", 0.5],
    ["rgb(255 0 0 / 25%)", "#FF0000", 0.25],
    ["#0af", "#00AAFF", 1],
    ["#00aaff80", "#00AAFF", 128 / 255],
    ["color(srgb 1 0.5 0)", "#FF8000", 1],
    // Tailwind v4 colors compute to oklch(); this is its blue-500, #2B7FFF.
    ["oklch(0.623 0.214 259.815)", "#2B7FFF", 1],
    ["oklch(100% 0 0)", "#FFFFFF", 1],
  ])("%s", (value, hex, alpha) => {
    const color = parseCssColor(value)!;
    expect(toHex(color)).toBe(hex);
    expect(color.a).toBeCloseTo(alpha, 2);
  });

  test("treats transparent and unknown syntax safely", () => {
    expect(parseCssColor("transparent")?.a).toBe(0);
    expect(parseCssColor("lab(50% 40 59)")).toBeUndefined();
    expect(parseCssColor(undefined)).toBeUndefined();
  });

  test("reads font stacks without quotes", () => {
    expect(fontStack('"Mona Sans", -apple-system, sans-serif')).toEqual([
      "Mona Sans",
      "-apple-system",
      "sans-serif",
    ]);
  });
});

describe("branding profile", () => {
  test("derives colors, components and typography from a light page", () => {
    const profile = buildBrandingProfile(page())!;
    expect(profile.colorScheme).toBe("light");
    expect(profile.colors).toEqual({
      background: "#FFFFFF",
      textPrimary: "#111111",
      textSecondary: "#6B7280",
      link: "#0EA5E9",
      primary: "#533AFD",
      accent: "#0EA5E9",
    });
    // The filled, chromatic call to action beats the outlined button and the header login link.
    expect(profile.components?.buttonPrimary).toEqual({
      background: "#533AFD",
      textColor: "#FFFFFF",
      borderRadius: "4px",
    });
    expect(profile.components?.buttonSecondary).toMatchObject({
      background: "transparent",
      textColor: "#533AFD",
      borderColor: "#B9B9F9",
    });
    expect(profile.components?.input).toMatchObject({
      borderColor: "#D1D5DB",
      borderRadius: "6px",
    });
    expect(profile.typography).toEqual({
      // Generic families such as ui-monospace are skipped in favor of the first named font.
      fontFamilies: { primary: "Inter", heading: "Playfair Display", code: "Menlo" },
      fontStacks: {
        primary: ["Inter", "sans-serif"],
        heading: ["Playfair Display", "serif"],
        code: ["ui-monospace", "Menlo", "monospace"],
      },
      fontSizes: { h1: "48px", body: "16px" },
      lineHeights: { heading: 1.1, body: 1.5 },
      fontWeights: { regular: 400, bold: 700 },
    });
    expect(profile.fonts).toEqual([{ family: "Inter" }, { family: "Playfair Display" }]);
    expect(profile.spacing).toEqual({ baseUnit: 8, borderRadius: "4px" });
    const fourGrid = [4, 12, 20, 8, 28, 12, 4, 36, 20, 12];
    expect(buildBrandingProfile(page({ spacing: fourGrid }))?.spacing?.baseUnit).toBe(4);
  });

  test("detects a dark page and ignores unreadable text colors", () => {
    const profile = buildBrandingProfile(
      page({
        root: { bodyBackground: "rgb(8, 9, 10)", color: "rgb(247, 248, 248)" },
        text: [
          { family: "Inter", color: "rgb(247, 248, 248)", chars: 1000 },
          // Near-black text on a near-black page cannot be the secondary text color.
          { family: "Inter", color: "rgb(20, 20, 20)", chars: 900 },
          { family: "Inter", color: "rgb(138, 143, 152)", chars: 500 },
        ],
      }),
    )!;
    expect(profile.colorScheme).toBe("dark");
    expect(profile.colors?.background).toBe("#08090A");
    expect(profile.colors?.textSecondary).toBe("#8A8F98");
  });

  test("measures the body from prose, not UI chrome or one monospace paragraph", () => {
    const profile = buildBrandingProfile(
      page({
        fonts: { paragraph: { family: "Geist Mono, monospace", size: "24px", lineHeight: "32px" } },
        text: [
          { family: "Geist, sans-serif", size: "12px", lineHeight: "14px", chars: 5000 },
          {
            family: "Geist, sans-serif",
            size: "16px",
            lineHeight: "24px",
            chars: 800,
            prose: true,
          },
          {
            family: "Geist Mono, monospace",
            size: "24px",
            lineHeight: "32px",
            chars: 40,
            prose: true,
          },
        ],
      }),
    )!;
    expect(profile.typography?.fontFamilies?.primary).toBe("Geist");
    expect(profile.typography?.fontSizes?.body).toBe("16px");
    expect(profile.typography?.lineHeights?.body).toBe(1.5);
  });

  test("ignores icon-only buttons and normalizes pill radii", () => {
    const profile = buildBrandingProfile(
      page({
        buttons: [
          button({ text: "", background: "rgb(58, 58, 58)", borderRadius: "50%" }),
          button({ borderRadius: "3.35544e+07px" }),
        ],
        inputs: [],
      }),
    )!;
    expect(profile.components?.buttonPrimary?.borderRadius).toBe("9999px");
    expect(profile.components?.buttonSecondary).toBeUndefined();
    // Circles and pills say nothing about the design's corner radius.
    expect(profile.spacing?.borderRadius).toBeUndefined();
  });

  test("falls back to large colored areas for the primary color when buttons are neutral", () => {
    const profile = buildBrandingProfile(
      page({
        buttons: [button({ background: "rgb(0, 0, 0)" })],
        backgrounds: [
          { color: "rgb(255, 255, 255)", area: 1_000_000 },
          { color: "rgb(184, 0, 0)", area: 200_000 },
        ],
        links: [],
      }),
    )!;
    expect(profile.colors?.primary).toBe("#B80000");
    expect(profile.components?.buttonPrimary?.background).toBe("#000000");
  });

  test("picks the header logo that links home, and names the brand", () => {
    const logos = [
      {
        src: "https://cdn.acme.test/partner.png",
        alt: "Partner",
        inHeader: false,
        hintMatch: false,
        top: 1500,
        left: 40,
        width: 120,
        height: 40,
      },
      {
        src: "https://cdn.acme.test/acme-logo.svg",
        alt: "Acme logo",
        href: "https://www.acme.co.uk/",
        inHeader: true,
        hintMatch: true,
        top: 20,
        left: 24,
        width: 96,
        height: 32,
      },
      {
        src: "https://cdn.acme.test/tiny.png",
        inHeader: true,
        hintMatch: true,
        top: 20,
        left: 0,
        width: 8,
        height: 8,
      },
    ];
    const profile = buildBrandingProfile(page({ logos }))!;
    expect(profile.logo).toBe("https://cdn.acme.test/acme-logo.svg");
    expect(profile.images).toMatchObject({
      logo: "https://cdn.acme.test/acme-logo.svg",
      logoHref: "https://www.acme.co.uk/",
      logoAlt: "Acme logo",
    });
    // The logo's alt text, without the word "logo", names the brand.
    expect(profile.brandName).toBe("Acme");
  });

  test.each([
    [{ siteName: "Acme Corp" }, "Pricing | Acme", "Acme Corp"],
    [{}, "Pricing | Acme", "Acme"],
    [{}, "Acme — Build faster", "Acme"],
    [{}, "Welcome", "Acme"],
  ])("brand name from %o and title %s", (meta, title, expected) => {
    expect(buildBrandingProfile(page({ meta, title }))?.brandName).toBe(expected);
  });

  test("prefers a sized icon for the favicon and falls back to /favicon.ico", () => {
    const icons = [
      { rel: "apple-touch-icon", href: "https://acme.test/apple.png", sizes: "180x180" },
      { rel: "icon", href: "https://acme.test/16.png", sizes: "16x16" },
      { rel: "icon", href: "https://acme.test/32.png", sizes: "32x32" },
      { rel: "mask-icon", href: "https://acme.test/mask.svg" },
    ];
    expect(buildBrandingProfile(page({ icons }))?.images?.favicon).toBe("https://acme.test/32.png");
    expect(buildBrandingProfile(page({ icons: [] }))?.images?.favicon).toBe(
      "https://www.acme.co.uk/favicon.ico",
    );
  });

  test("returns a usable profile from sparse samples and nothing from garbage", () => {
    expect(buildBrandingProfile({})).toMatchObject({
      colorScheme: "light",
      colors: { background: "#FFFFFF" },
      logo: null,
    });
    expect(buildBrandingProfile(null)).toBeUndefined();
    expect(buildBrandingProfile("not samples")).toBeUndefined();
  });

  test("ships an in-page script that parses", () => {
    expect(() => new Function(BRANDING_SCRIPT)).not.toThrow();
  });
});

class StubRenderer implements Renderer {
  calls = 0;

  constructor(
    readonly name: string,
    private readonly computedStyles: boolean,
  ) {}

  capabilities() {
    return {
      available: true,
      browser: true,
      javascript: true,
      screenshots: true,
      cdp: this.computedStyles,
      computedStyles: this.computedStyles,
    };
  }

  async render(request: RenderRequest): Promise<RenderResult> {
    this.calls += 1;
    if (this.name === "webview") throw new Error("Chrome crashed");
    return {
      sourceUrl: request.url,
      finalUrl: request.url,
      title: "",
      html: "<p>x</p>",
      renderer: this.name,
      elapsedMs: 1,
    };
  }
}

describe("branding renderer routing", () => {
  test("never falls back to a renderer that cannot compute styles", async () => {
    const lightpanda = new StubRenderer("lightpanda", false);
    const webview = new StubRenderer("webview", true);
    const chain = new RendererChain([lightpanda, webview]);
    // The real error surfaces instead of Lightpanda's "cannot measure branding".
    await expect(
      chain.render({ url: "https://acme.test", deadline: new Deadline(1000), branding: true }),
    ).rejects.toThrow("Chrome crashed");
    expect(lightpanda.calls).toBe(0);
    expect(chain.capabilities().computedStyles).toBe(true);
  });
});
