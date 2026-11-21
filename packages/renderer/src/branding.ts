import type { BrandingProfile } from "@buncrawl/contracts";

/**
 * Runs in the rendered page and returns raw computed-style samples. It only measures; every
 * decision (which color is primary, which image is the logo) is made by buildBrandingProfile so it
 * can be tested without a browser. Every list is capped to keep huge pages cheap.
 */
export const BRANDING_SCRIPT = `(() => {
  const MAX_ELEMENTS = 1500;
  const style = (el) => getComputedStyle(el);
  const rect = (el) => el.getBoundingClientRect();
  const visible = (el) => {
    const r = rect(el);
    const s = style(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0;
  };
  const meta = (selector) => document.querySelector(selector)?.getAttribute("content")?.trim() || undefined;
  const inHeader = (el) => Boolean(el.closest("header, nav, [role=banner], [class*=header i], [id*=header i]"));
  const textOf = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 80);
  const box = (el) => {
    const r = rect(el);
    return { top: Math.round(r.top + scrollY), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const paint = (s) => ({
    background: s.backgroundColor,
    color: s.color,
    borderColor: s.borderTopColor,
    borderWidth: parseFloat(s.borderTopWidth) || 0,
    borderRadius: s.borderTopLeftRadius,
    shadow: s.boxShadow,
  });

  const html = document.documentElement;
  const body = document.body || html;
  const htmlStyle = style(html);
  const bodyStyle = style(body);
  // Screen-reader-only headings are 1px boxes or clipped away; skip them for typography.
  const firstShown = (selector) =>
    Array.from(body.querySelectorAll(selector)).find((el) => {
      const r = rect(el);
      return visible(el) && r.height >= 8 && r.width >= 8 && style(el).clip === "auto" && (el.innerText || "").trim().length > 0;
    });
  const font = (el) => {
    if (!el) return undefined;
    const s = style(el);
    return { family: s.fontFamily, size: s.fontSize, lineHeight: s.lineHeight, weight: Number(s.fontWeight) || 400 };
  };

  const elements = Array.from(body.querySelectorAll("*")).slice(0, MAX_ELEMENTS);
  const text = [];
  const backgrounds = [];
  const spacing = [];
  for (const el of elements) {
    if (!visible(el)) continue;
    const s = style(el);
    const r = rect(el);
    if (r.width * r.height > 0) backgrounds.push({ color: s.backgroundColor, area: Math.round(r.width * r.height) });
    for (const value of [s.paddingTop, s.paddingLeft, s.marginTop, s.marginBottom, s.columnGap]) {
      const px = parseFloat(value);
      if (px > 0 && px <= 128) spacing.push(px);
    }
    let own = 0;
    for (const node of el.childNodes) if (node.nodeType === 3) own += node.textContent.trim().length;
    const prose = Boolean(el.closest("p, li, dd, blockquote"));
    if (own > 0) text.push({ family: s.fontFamily, size: s.fontSize, lineHeight: s.lineHeight, color: s.color, weight: Number(s.fontWeight) || 400, chars: own, prose });
  }

  const links = Array.from(body.querySelectorAll("a[href]"))
    .filter((el) => visible(el) && !el.closest("header, nav, footer"))
    .slice(0, 300)
    .map((el) => ({ color: style(el).color, chars: textOf(el).length }));

  const buttonSelector = 'button, [role=button], input[type=submit], input[type=button], a[class*=btn i], a[class*=button i], a[class*=cta i]';
  // Many sites style plain links as buttons with generated class names: a padded, filled or
  // bordered link of button height with a short label.
  const styledLinks = Array.from(body.querySelectorAll("a[href]")).slice(0, 500).filter((el) => {
    const s = style(el);
    const r = rect(el);
    const label = textOf(el).length;
    const filled = (parseCssAlpha(s.backgroundColor) > 0.5) || (parseFloat(s.borderTopWidth) || 0) > 0;
    return filled && (parseFloat(s.paddingLeft) || 0) >= 8 && label > 0 && label <= 40 && r.height >= 24 && r.height <= 80;
  });
  function parseCssAlpha(value) {
    if (!value || value === "transparent") return 0;
    const inner = value.slice(value.indexOf("(") + 1, value.lastIndexOf(")"));
    const modern = inner.includes("/");
    const parts = modern ? inner.split("/") : inner.split(",");
    if (parts.length < (modern ? 2 : 4)) return 1;
    const token = parts[parts.length - 1].trim();
    return token.endsWith("%") ? parseFloat(token) / 100 : parseFloat(token);
  }
  const buttons = Array.from(new Set([...body.querySelectorAll(buttonSelector), ...styledLinks]))
    .filter(visible)
    .slice(0, 80)
    .map((el) => ({ text: textOf(el), inHeader: inHeader(el), ...box(el), ...paint(style(el)) }));

  const inputs = Array.from(body.querySelectorAll('input:not([type]), input[type=text], input[type=email], input[type=search], input[type=tel], input[type=url], textarea'))
    .filter(visible)
    .slice(0, 20)
    .map((el) => paint(style(el)));

  const logos = [];
  const logoPattern = /logo|brand/i;
  const candidates = new Set([
    ...document.querySelectorAll("header img, header svg, nav img, nav svg, [role=banner] img, [role=banner] svg"),
    ...document.querySelectorAll('img[class*=logo i], img[id*=logo i], img[alt*=logo i], img[src*=logo i], svg[class*=logo i], [class*=logo i] > img, [class*=logo i] > svg, a[rel=home] img, a[rel=home] svg'),
  ]);
  for (const el of Array.from(candidates).slice(0, 40)) {
    if (!visible(el)) continue;
    const anchor = el.closest("a[href]");
    const isSvg = el.tagName.toLowerCase() === "svg";
    let src;
    if (isSvg) {
      const markup = new XMLSerializer().serializeToString(el);
      if (markup.length <= 20000) src = "data:image/svg+xml;utf8," + encodeURIComponent(markup);
    } else {
      src = el.currentSrc || el.src;
    }
    if (!src) continue;
    const hint = [el.className?.baseVal ?? el.className, el.id, el.getAttribute("alt"), isSvg ? "" : el.getAttribute("src"), el.parentElement?.className, anchor?.className]
      .filter((value) => typeof value === "string")
      .join(" ");
    logos.push({
      src,
      isSvg,
      alt: (el.getAttribute("alt") || anchor?.getAttribute("aria-label") || el.getAttribute("aria-label") || "").trim(),
      href: anchor?.href,
      inHeader: inHeader(el),
      hintMatch: logoPattern.test(hint),
      ...box(el),
    });
  }

  const icons = Array.from(document.querySelectorAll("link[rel][href]"))
    .filter((el) => /icon/i.test(el.getAttribute("rel") || ""))
    .slice(0, 20)
    .map((el) => ({ rel: el.getAttribute("rel").toLowerCase(), href: el.href, sizes: el.getAttribute("sizes") || "" }));

  return {
    url: location.href,
    title: document.title,
    meta: {
      siteName: meta('meta[property="og:site_name"]'),
      applicationName: meta('meta[name="application-name"]'),
      ogImage: meta('meta[property="og:image"]') ? new URL(meta('meta[property="og:image"]'), location.href).href : undefined,
      colorScheme: meta('meta[name="color-scheme"]'),
    },
    root: { htmlBackground: htmlStyle.backgroundColor, bodyBackground: bodyStyle.backgroundColor, color: bodyStyle.color },
    fonts: {
      body: font(body),
      paragraph: font(firstShown("main p, article p, p")),
      h1: font(firstShown("h1")),
      h2: font(firstShown("h2")),
      h3: font(firstShown("h3")),
      code: font(firstShown("code, pre, kbd")),
    },
    text: text.slice(0, 2000),
    backgrounds: backgrounds.slice(0, 2000),
    spacing: spacing.slice(0, 4000),
    links,
    buttons,
    inputs,
    logos,
    icons,
  };
})()`;

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface FontSample {
  family?: string;
  size?: string;
  lineHeight?: string;
  weight?: number;
}

interface PaintSample {
  background?: string;
  color?: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: string;
  shadow?: string;
}

interface ButtonSample extends PaintSample {
  text?: string;
  inHeader?: boolean;
  top?: number;
  width?: number;
  height?: number;
}

interface LogoSample {
  src?: string;
  isSvg?: boolean;
  alt?: string;
  href?: string;
  inHeader?: boolean;
  hintMatch?: boolean;
  top?: number;
  left?: number;
  width?: number;
  height?: number;
}

/** The shape BRANDING_SCRIPT returns; every field is optional because pages vary wildly. */
export interface BrandingSamples {
  url?: string;
  title?: string;
  meta?: {
    siteName?: string;
    applicationName?: string;
    ogImage?: string;
    colorScheme?: string;
  };
  root?: { htmlBackground?: string; bodyBackground?: string; color?: string };
  fonts?: Partial<Record<"body" | "paragraph" | "h1" | "h2" | "h3" | "code", FontSample>>;
  text?: Array<{
    family?: string;
    size?: string;
    lineHeight?: string;
    color?: string;
    weight?: number;
    chars?: number;
    /** Inside a paragraph or list item, as opposed to navigation, labels or UI chrome. */
    prose?: boolean;
  }>;
  backgrounds?: Array<{ color?: string; area?: number }>;
  spacing?: number[];
  links?: Array<{ color?: string; chars?: number }>;
  buttons?: ButtonSample[];
  inputs?: PaintSample[];
  logos?: LogoSample[];
  icons?: Array<{ rel?: string; href?: string; sizes?: string }>;
}

const GENERIC_FONTS = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "-apple-system",
  "blinkmacsystemfont",
  "apple color emoji",
  "segoe ui emoji",
  "segoe ui symbol",
  "noto color emoji",
]);

/** Turns raw page samples into a profile; returns undefined when the samples are unusable. */
export function buildBrandingProfile(input: unknown): BrandingProfile | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const samples = input as BrandingSamples;
  const profile: BrandingProfile = {};

  const background = pageBackground(samples);
  profile.colorScheme =
    luminance(background) < 0.4 ||
    (samples.meta?.colorScheme?.trim() === "dark" && luminance(background) < 0.6)
      ? "dark"
      : "light";

  const buttons = rankButtons(samples.buttons ?? [], background);
  const colors = pickColors(samples, background, buttons);
  if (Object.keys(colors).length) profile.colors = colors;

  const fonts = rankFonts(samples);
  if (fonts.length) profile.fonts = fonts.map((family) => ({ family }));
  const typography = buildTypography(samples);
  if (typography) profile.typography = typography;

  const spacing = buildSpacing(samples, buttons);
  if (spacing) profile.spacing = spacing;

  const components: NonNullable<BrandingProfile["components"]> = {};
  if (buttons[0]) components.buttonPrimary = component(buttons[0]);
  if (buttons[1]) components.buttonSecondary = component(buttons[1]);
  const input0 = (samples.inputs ?? [])[0];
  if (input0) components.input = component(input0);
  if (Object.keys(components).length) profile.components = components;

  const logo = pickLogo(samples.logos ?? []);
  const brandName = pickBrandName(samples, logo);
  if (brandName) profile.brandName = brandName;
  const images: NonNullable<BrandingProfile["images"]> = {
    logo: logo?.src ?? null,
    logoHref: logo?.href ?? null,
    logoAlt: logo?.alt || null,
    favicon: pickFavicon(samples),
    ogImage: samples.meta?.ogImage ?? null,
  };
  profile.logo = images.logo;
  profile.images = images;
  return profile;
}

/** Parses the color forms getComputedStyle returns: rgb()/rgba(), hex, oklch()/oklab(), color(srgb). */
export function parseCssColor(value: string | undefined): Rgba | undefined {
  if (!value) return undefined;
  const text = value.trim().toLowerCase();
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = text.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    const digits = hex[1]!;
    const full =
      digits.length <= 4
        ? digits
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : digits;
    if (full.length !== 6 && full.length !== 8) return undefined;
    const channel = (index: number) => parseInt(full.slice(index, index + 2), 16);
    return {
      r: channel(0),
      g: channel(2),
      b: channel(4),
      a: full.length === 8 ? channel(6) / 255 : 1,
    };
  }
  const fn = text.match(/^([a-z]+)\((.*)\)$/);
  if (!fn) return undefined;
  const name = fn[1]!;
  const [channels, alphaPart] = fn[2]!.split("/").map((part) => part.trim());
  const parts = channels!.split(/[\s,]+/).filter(Boolean);
  // Only the legacy rgb()/rgba() comma syntax puts alpha in a fourth channel.
  const legacyAlpha = (name === "rgb" || name === "rgba") && parts.length === 4;
  const alphaToken = alphaPart ?? (legacyAlpha ? parts[3] : undefined);
  const alpha = alphaToken === undefined ? 1 : number(alphaToken, 1);
  if (name === "rgb" || name === "rgba") {
    if (parts.length < 3) return undefined;
    const channel = (token: string) =>
      clamp255(token.endsWith("%") ? number(token, 255) : number(token, 1));
    return { r: channel(parts[0]!), g: channel(parts[1]!), b: channel(parts[2]!), a: alpha };
  }
  if (name === "color" && parts[0] === "srgb" && parts.length >= 4) {
    const channel = (token: string) => clamp255(number(token, 1) * 255);
    return { r: channel(parts[1]!), g: channel(parts[2]!), b: channel(parts[3]!), a: alpha };
  }
  if ((name === "oklch" || name === "oklab") && parts.length >= 3) {
    const lightness = number(parts[0]!, 1);
    let a: number;
    let b: number;
    if (name === "oklch") {
      const chroma = number(parts[1]!, 0.4);
      const hue = (number(parts[2]!, 1) * Math.PI) / 180;
      a = chroma * Math.cos(hue);
      b = chroma * Math.sin(hue);
    } else {
      a = number(parts[1]!, 0.4);
      b = number(parts[2]!, 0.4);
    }
    return { ...oklabToSrgb(lightness, a, b), a: alpha };
  }
  return undefined;
}

export function toHex(color: Rgba): string {
  const hex = (channel: number) => Math.round(channel).toString(16).padStart(2, "0");
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`.toUpperCase();
}

/** A token such as "50%" or "0.5"; `percentScale` maps 100% onto the channel's range. */
function number(token: string, percentScale: number): number {
  if (token === "none") return 0;
  const value = parseFloat(token);
  if (!Number.isFinite(value)) return 0;
  return token.endsWith("%") ? (value / 100) * percentScale : value;
}

function clamp255(value: number): number {
  return Math.min(255, Math.max(0, value));
}

function oklabToSrgb(lightness: number, a: number, b: number): Omit<Rgba, "a"> {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const [r, g, bl] = linear.map((channel) => {
    const encoded =
      channel <= 0.0031308 ? 12.92 * channel : 1.055 * Math.max(channel, 0) ** (1 / 2.4) - 0.055;
    return clamp255(encoded * 255);
  }) as [number, number, number];
  return { r, g, b: bl };
}

function luminance(color: Rgba): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** WCAG contrast ratio, from 1 (identical) to 21 (black on white). */
function contrast(left: Rgba, right: Rgba): number {
  const [light, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

function saturation(color: Rgba): number {
  const max = Math.max(color.r, color.g, color.b);
  const min = Math.min(color.r, color.g, color.b);
  return max === 0 ? 0 : (max - min) / max;
}

/** Chromatic enough to be a brand color rather than a gray, black or white. */
function isChromatic(color: Rgba): boolean {
  const max = Math.max(color.r, color.g, color.b);
  return saturation(color) >= 0.25 && max >= 40;
}

function distance(left: Rgba, right: Rgba): number {
  return Math.hypot(left.r - right.r, left.g - right.g, left.b - right.b);
}

function opaque(value: string | undefined): Rgba | undefined {
  const color = parseCssColor(value);
  return color && color.a >= 0.5 ? color : undefined;
}

function pageBackground(samples: BrandingSamples): Rgba {
  return (
    opaque(samples.root?.bodyBackground) ??
    opaque(samples.root?.htmlBackground) ?? { r: 255, g: 255, b: 255, a: 1 }
  );
}

interface RankedButton extends ButtonSample {
  fill?: Rgba;
}

/**
 * Orders buttons by how much they look like the page's main call to action: a solid, chromatic,
 * reasonably sized fill that stands out from the page background, above the fold, outside the nav.
 * Buttons with the same fill collapse to one so primary and secondary differ.
 */
function rankButtons(buttons: readonly ButtonSample[], background: Rgba): RankedButton[] {
  const scored = buttons
    // Icon-only controls (menus, carousels, close buttons) are not calls to action.
    .filter(
      (button) =>
        (button.text ?? "").length > 0 && (button.width ?? 0) >= 24 && (button.height ?? 0) >= 16,
    )
    .map((button) => {
      const fill = opaque(button.background);
      const border = parseCssColor(button.borderColor);
      const filled = fill && distance(fill, background) > 30;
      const outlined = !filled && (button.borderWidth ?? 0) > 0 && border && border.a > 0.5;
      if (!filled && !outlined) return undefined;
      let score = filled ? 4 : 1;
      if (fill && filled && isChromatic(fill)) score += 4;
      if ((button.top ?? Infinity) < 900) score += 2;
      if (!button.inHeader) score += 1;
      score += Math.min(2, ((button.width ?? 0) * (button.height ?? 0)) / 8000);
      return { button: { ...button, ...(filled ? { fill } : {}) }, score };
    })
    .filter((entry): entry is { button: RankedButton; score: number } => entry !== undefined)
    .sort((left, right) => right.score - left.score);

  const seen: string[] = [];
  const ranked: RankedButton[] = [];
  for (const { button } of scored) {
    const key = `${button.background}|${button.color}|${button.borderColor}`;
    if (seen.includes(key)) continue;
    seen.push(key);
    ranked.push(button);
  }
  return ranked;
}

function pickColors(
  samples: BrandingSamples,
  background: Rgba,
  buttons: readonly RankedButton[],
): NonNullable<BrandingProfile["colors"]> {
  const colors: NonNullable<BrandingProfile["colors"]> = { background: toHex(background) };
  const text = weightedColors(
    (samples.text ?? []).map((sample) => [sample.color, sample.chars ?? 0]),
  );
  const textPrimary = opaque(samples.root?.color) ?? text[0];
  if (textPrimary) colors.textPrimary = toHex(textPrimary);
  // Readable on the page background: white text from dark sections is not secondary body text.
  const textSecondary = text.find(
    (color) =>
      !isChromatic(color) &&
      contrast(color, background) >= 3 &&
      (!textPrimary || distance(color, textPrimary) > 24),
  );
  if (textSecondary) colors.textSecondary = toHex(textSecondary);
  const link = weightedColors(
    (samples.links ?? []).map((sample) => [sample.color, Math.max(1, sample.chars ?? 0)]),
  )[0];
  if (link) colors.link = toHex(link);

  // Fills carry the brand: buttons first, then large colored areas. The link color is the accent,
  // and only stands in as primary on pages with no other color.
  const candidates = [
    ...buttons.flatMap((button) => (button.fill ? [button.fill] : [])),
    ...weightedColors(
      (samples.backgrounds ?? []).map((sample) => [sample.color, sample.area ?? 0]),
    ),
  ].filter(isChromatic);
  if (candidates.length === 0 && link && isChromatic(link)) candidates.push(link);

  const brand: Rgba[] = [];
  for (const color of candidates)
    if (brand.every((existing) => distance(existing, color) > 48)) brand.push(color);
  if (brand[0]) colors.primary = toHex(brand[0]);
  if (brand[1]) colors.secondary = toHex(brand[1]);
  const accent =
    link && isChromatic(link) && brand.slice(0, 2).every((color) => distance(color, link) > 48)
      ? link
      : brand[2];
  if (accent) colors.accent = toHex(accent);
  return colors;
}

/** Opaque colors ordered by total weight, merging near-identical shades. */
function weightedColors(entries: Array<[string | undefined, number]>): Rgba[] {
  const totals: Array<{ color: Rgba; weight: number }> = [];
  for (const [value, weight] of entries) {
    const color = opaque(value);
    if (!color || weight <= 0) continue;
    const existing = totals.find((entry) => distance(entry.color, color) < 12);
    if (existing) existing.weight += weight;
    else totals.push({ color, weight });
  }
  return totals.sort((left, right) => right.weight - left.weight).map((entry) => entry.color);
}

/** Font families as written in a CSS stack, without quotes. */
export function fontStack(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((family) => family.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function primaryFamily(value: string | undefined): string | undefined {
  const stack = fontStack(value);
  return stack.find((family) => !GENERIC_FONTS.has(family.toLowerCase())) ?? stack[0];
}

function rankFonts(samples: BrandingSamples): string[] {
  return [...fontUsage(samples).entries()]
    .sort((left, right) => right[1].chars - left[1].chars)
    .map(([family]) => family)
    .slice(0, 5);
}

/** Characters of text set in each family, with the first full stack seen for it. */
function fontUsage(samples: BrandingSamples): Map<string, { chars: number; stack: string }> {
  const totals = new Map<string, { chars: number; stack: string }>();
  for (const sample of samples.text ?? []) {
    const family = primaryFamily(sample.family);
    if (!family) continue;
    const entry = totals.get(family) ?? { chars: 0, stack: sample.family! };
    entry.chars += sample.chars ?? 0;
    totals.set(family, entry);
  }
  for (const key of ["h1", "h2", "body"] as const) {
    const stack = samples.fonts?.[key]?.family;
    const family = primaryFamily(stack);
    if (family && !totals.has(family)) totals.set(family, { chars: 0, stack: stack! });
  }
  return totals;
}

function buildTypography(samples: BrandingSamples): BrandingProfile["typography"] {
  const fonts = samples.fonts ?? {};
  const paragraph = fonts.paragraph ?? fonts.body;
  // The body face is whichever font sets the most text; one monospace paragraph must not win.
  const [mostUsed] = [...fontUsage(samples).entries()].sort(
    (left, right) => right[1].chars - left[1].chars,
  );
  const bodyFont: FontSample | undefined =
    mostUsed && mostUsed[1].chars > 0
      ? { ...paragraph, ...mostUsedMetrics(samples), family: mostUsed[1].stack }
      : paragraph;
  const heading = fonts.h1 ?? fonts.h2 ?? fonts.h3;
  const typography: NonNullable<BrandingProfile["typography"]> = {};

  const families = {
    ...(primaryFamily(bodyFont?.family) ? { primary: primaryFamily(bodyFont?.family) } : {}),
    ...(primaryFamily(heading?.family) ? { heading: primaryFamily(heading?.family) } : {}),
    ...(primaryFamily(fonts.code?.family) ? { code: primaryFamily(fonts.code?.family) } : {}),
  };
  if (Object.keys(families).length) typography.fontFamilies = families;

  const stacks = {
    ...(bodyFont?.family ? { primary: fontStack(bodyFont.family) } : {}),
    ...(heading?.family ? { heading: fontStack(heading.family) } : {}),
    ...(fonts.code?.family ? { code: fontStack(fonts.code.family) } : {}),
  };
  if (Object.keys(stacks).length) typography.fontStacks = stacks;

  const sizes = {
    ...(fonts.h1?.size ? { h1: fonts.h1.size } : {}),
    ...(fonts.h2?.size ? { h2: fonts.h2.size } : {}),
    ...(fonts.h3?.size ? { h3: fonts.h3.size } : {}),
    ...(bodyFont?.size ? { body: bodyFont.size } : {}),
  };
  if (Object.keys(sizes).length) typography.fontSizes = sizes;

  const bodyLine = lineHeightRatio(bodyFont);
  const headingLine = lineHeightRatio(heading);
  if (bodyLine !== undefined || headingLine !== undefined)
    typography.lineHeights = {
      ...(headingLine === undefined ? {} : { heading: headingLine }),
      ...(bodyLine === undefined ? {} : { body: bodyLine }),
    };

  const regular = bodyFont?.weight;
  const bold = Math.max(
    0,
    ...[fonts.h1, fonts.h2, fonts.h3].map((font) => font?.weight ?? 0),
    ...(samples.text ?? []).map((sample) => sample.weight ?? 0),
  );
  if (regular || bold)
    typography.fontWeights = {
      ...(regular ? { regular } : {}),
      ...(bold && bold !== regular ? { bold } : {}),
    };
  return Object.keys(typography).length ? typography : undefined;
}

/**
 * The font size (with its line height) that sets the most characters: the real body size. Prose
 * decides when there is enough of it, so UI mock-ups and navigation do not.
 */
function mostUsedMetrics(samples: BrandingSamples): Pick<FontSample, "size" | "lineHeight"> {
  const all = samples.text ?? [];
  const prose = all.filter((sample) => sample.prose);
  const proseChars = prose.reduce((sum, sample) => sum + (sample.chars ?? 0), 0);
  const totals = new Map<string, { chars: number; lineHeight?: string }>();
  for (const sample of proseChars >= 200 ? prose : all) {
    if (!sample.size) continue;
    const entry = totals.get(sample.size) ?? { chars: 0, lineHeight: sample.lineHeight };
    entry.chars += sample.chars ?? 0;
    totals.set(sample.size, entry);
  }
  const [size, entry] =
    [...totals.entries()].sort((left, right) => right[1].chars - left[1].chars)[0] ?? [];
  return size ? { size, ...(entry?.lineHeight ? { lineHeight: entry.lineHeight } : {}) } : {};
}

/** "24px" over a 16px font is 1.5; "normal" has no fixed ratio. */
function lineHeightRatio(font: FontSample | undefined): number | undefined {
  const lineHeight = parseFloat(font?.lineHeight ?? "");
  const size = parseFloat(font?.size ?? "");
  if (!Number.isFinite(lineHeight) || !Number.isFinite(size) || size <= 0) return undefined;
  return Math.round((lineHeight / size) * 100) / 100;
}

function buildSpacing(
  samples: BrandingSamples,
  buttons: readonly RankedButton[],
): BrandingProfile["spacing"] {
  const spacing: NonNullable<BrandingProfile["spacing"]> = {};
  const values = (samples.spacing ?? []).filter((value) => value > 0);
  if (values.length >= 10) {
    const share = (unit: number) =>
      values.filter((value) => Math.abs(value / unit - Math.round(value / unit)) < 0.01).length /
      values.length;
    if (share(8) >= 0.6) spacing.baseUnit = 8;
    else if (share(4) >= 0.6) spacing.baseUnit = 4;
  }
  const radii = new Map<string, number>();
  for (const sample of [...buttons, ...(samples.inputs ?? [])]) {
    const radius = sample.borderRadius;
    // Circles and pills say little about the design's corner radius.
    if (radius && !radius.includes("%") && parseFloat(radius) > 0 && parseFloat(radius) < 999)
      radii.set(radius, (radii.get(radius) ?? 0) + 1);
  }
  const radius = [...radii.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  if (radius) spacing.borderRadius = radius;
  return Object.keys(spacing).length ? spacing : undefined;
}

/** `9999rem` computes to absurd pixel values; any radius that large just means "pill". */
function cornerRadius(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return !value.includes("%") && parseFloat(value) >= 999 ? "9999px" : value;
}

function component(sample: PaintSample) {
  const fill = opaque(sample.background);
  const text = opaque(sample.color);
  const border = parseCssColor(sample.borderColor);
  const shadow = sample.shadow && sample.shadow !== "none" ? sample.shadow : undefined;
  return {
    background: fill ? toHex(fill) : "transparent",
    ...(text ? { textColor: toHex(text) } : {}),
    ...((sample.borderWidth ?? 0) > 0 && border && border.a > 0
      ? { borderColor: toHex(border) }
      : {}),
    ...(sample.borderRadius ? { borderRadius: cornerRadius(sample.borderRadius) } : {}),
    ...(shadow ? { shadow } : {}),
  };
}

/** Best logo candidate: in the header, named like a logo, linking home, near the top-left. */
function pickLogo(logos: readonly LogoSample[]): LogoSample | undefined {
  let best: { logo: LogoSample; score: number } | undefined;
  for (const logo of logos) {
    const width = logo.width ?? 0;
    const height = logo.height ?? 0;
    if (!logo.src || width < 16 || height < 10 || width > 640 || height > 320) continue;
    let score = 0;
    if (logo.inHeader) score += 3;
    if (logo.hintMatch) score += 3;
    if (logo.href && isHomeLink(logo.href)) score += 2;
    if ((logo.top ?? Infinity) < 200) score += 1;
    if ((logo.left ?? Infinity) < 400) score += 1;
    if (score < 3) continue;
    if (!best || score > best.score) best = { logo, score };
  }
  return best?.logo;
}

function isHomeLink(href: string): boolean {
  try {
    const url = new URL(href);
    return url.pathname === "/" || url.pathname === "";
  } catch {
    return false;
  }
}

function pickBrandName(samples: BrandingSamples, logo: LogoSample | undefined): string | undefined {
  const declared = samples.meta?.siteName ?? samples.meta?.applicationName;
  if (declared) return declared;
  const alt = logo?.alt?.replace(/\s*(logo|home(page)?)\s*$/i, "").trim();
  if (alt && !/^(logo|home)$/i.test(alt)) return alt;

  const host = hostLabel(samples.url);
  const parts = (samples.title ?? "")
    .split(/\s+[|–—·:-]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const matching = host
    ? parts.find((part) =>
        part
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .includes(host),
      )
    : undefined;
  if (matching) return matching;
  if (parts.length > 1) return parts.at(-1);
  if (host) return host.charAt(0).toUpperCase() + host.slice(1);
  return parts[0];
}

/** "www.bbc.co.uk" -> "bbc": the registrable label most brands are named after. */
function hostLabel(url: string | undefined): string | undefined {
  try {
    const labels = new URL(url ?? "").hostname.replace(/^www\./, "").split(".");
    if (labels.length >= 3 && labels.at(-2)!.length <= 3) return labels.at(-3);
    return labels.length >= 2 ? labels.at(-2) : labels[0];
  } catch {
    return undefined;
  }
}

function pickFavicon(samples: BrandingSamples): string | null {
  const icons = samples.icons ?? [];
  const size = (sizes: string | undefined) => {
    if (sizes === "any") return 1024;
    return Math.max(0, ...(sizes ?? "").split(/\s+/).map((entry) => parseInt(entry, 10) || 0));
  };
  const rank = (rel: string | undefined) =>
    rel?.split(/\s+/).includes("icon") ? 0 : rel?.includes("apple-touch-icon") ? 1 : 2;
  const best = icons
    .filter((icon) => icon.href && !icon.rel?.includes("mask-icon"))
    .sort(
      (left, right) => rank(left.rel) - rank(right.rel) || size(right.sizes) - size(left.sizes),
    )[0];
  if (best?.href) return best.href;
  try {
    return samples.url ? new URL("/favicon.ico", samples.url).href : null;
  } catch {
    return null;
  }
}
