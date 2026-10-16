import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Accessibility contract of the shared shadcn components (Phase 07D-0 review). Database-free, Node only, so it runs in `npm test`.
//
// 1. PRIMARY HOVER CONTRAST. The default Button and the linked default Badge must keep white-on-primary text at 4.5:1 or more
//    when hovered. The defect this guards against: `hover:bg-primary/80` composites a TRANSLUCENT primary over the page, which
//    rendered rgb(51,149,119) behind white text, 3.68:1. The test reads the real theme tokens from globals.css and the real
//    hover classes from the component source, refuses any translucent primary hover, evaluates each opaque
//    `color-mix(in oklch, ...)` exactly as CSS does, and checks the WCAG ratio and that the hover is visibly different.
//    This proves the colour arithmetic. It is not a rendering test: the browser measurement is in the 07D-0 report.
// 2. TOGGLE GROUP ORIENTATION (static only). The wrapper must forward `orientation` to the Base UI primitive, whose composite
//    navigation reads it (vertical = ArrowUp/ArrowDown). This is a source assertion; it does not prove runtime keyboard
//    behaviour (verified in a browser in the 07D-0 report).

const repo = process.cwd();
const read = (p: string) => readFileSync(join(repo, p), "utf8");

type Oklch = { l: number; c: number; h: number | null };

/** `oklch(50.8% 0.118 165.612)` / `oklch(1 0 0)`; an achromatic colour has a powerless hue (null), as CSS treats it. */
function parseOklch(value: string): Oklch {
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+|none)\s*\)$/.exec(value.trim());
  if (!m) throw new Error(`not an oklch() token: ${value}`);
  const l = Number(m[1]) / (m[2] ? 100 : 1);
  const c = Number(m[3]);
  return { l, c, h: c === 0 || m[4] === "none" ? null : Number(m[4]) };
}

function tokens(css: string, selector: ":root" | ".dark"): Record<string, Oklch> {
  const start = css.indexOf(`\n${selector} {`);
  const block = css.slice(start, css.indexOf("\n}", start));
  const out: Record<string, Oklch> = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(oklch\([^;/]+\));/g))
    out[m[1]!] = parseOklch(m[2]!);
  return out;
}

/** CSS `color-mix(in oklch, A, B p%)`: linear in L and C; a missing (powerless) hue takes the other colour's hue. */
function mix(a: Oklch, b: Oklch, p: number): Oklch {
  let h: number | null = null;
  if (a.h === null) h = b.h;
  else if (b.h === null) h = a.h;
  else {
    let d = b.h - a.h; // shorter hue arc
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    h = (a.h + d * p + 360) % 360;
  }
  return { l: a.l * (1 - p) + b.l * p, c: a.c * (1 - p) + b.c * p, h };
}

/** OKLCH -> 8-bit sRGB (Björn Ottosson's OKLab matrices), gamut-clipped the way the browser paints it. */
function toRgb({ l, c, h }: Oklch): [number, number, number] {
  const rad = ((h ?? 0) * Math.PI) / 180;
  const A = c * Math.cos(rad);
  const B = c * Math.sin(rad);
  const L_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const M_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const S_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const lin = [
    4.0767416621 * L_ - 3.3077115913 * M_ + 0.2309699292 * S_,
    -1.2684380046 * L_ + 2.6097574011 * M_ - 0.3413193965 * S_,
    -0.0041960863 * L_ - 0.7034186147 * M_ + 1.707614701 * S_,
  ];
  const enc = (v: number) => {
    const x = Math.min(1, Math.max(0, v));
    return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  };
  return [enc(lin[0]!), enc(lin[1]!), enc(lin[2]!)];
}

function contrast(x: [number, number, number], y: [number, number, number]) {
  const lum = (rgb: number[]) =>
    rgb
      .map((v) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (a! + 0.05) / (b! + 0.05);
}

/** The class string of a cva variant: `<name>:` followed by one string literal. */
function variantClasses(source: string, name: string): string {
  const m = new RegExp(`\\b${name}:\\s*"([^"]+)"`).exec(source);
  if (!m) throw new Error(`variant ${name} not found`);
  return m[1]!;
}

const css = read("src/app/globals.css");
const themes = { light: tokens(css, ":root"), dark: tokens(css, ".dark") };
const MIN = 4.5;

describe("colour model sanity (matches what Chromium rendered in the 07D-0 measurement)", () => {
  it("reproduces the measured primary and hover colours", () => {
    const t = themes.light;
    expect(toRgb(t.primary!)).toEqual([0, 122, 85]);
    expect(toRgb(mix(t.primary!, t.foreground!, 0.2))).toEqual([0, 97, 69]);
    expect(toRgb(mix(themes.dark.primary!, themes.dark.background!, 0.2))).toEqual([179, 179, 179]);
  });
});

describe.each([
  ["Button", "src/components/ui/button.tsx", /(dark:)?hover:bg-(\S+)/g],
  ["Badge (linked)", "src/components/ui/badge.tsx", /(dark:)?\[a\]:hover:bg-(\S+)/g],
] as const)(
  "%s, default variant: text contrast in normal and hover states",
  (_name, file, pattern) => {
    const classes = variantClasses(read(file), "default");
    const hovers = [...classes.matchAll(pattern)].map((m) => ({
      theme: m[1] ? ("dark" as const) : ("light" as const),
      value: m[2]!,
    }));

    it("has an opaque hover for each theme, never a translucent primary", () => {
      expect(hovers.map((h) => h.theme).sort()).toEqual(["dark", "light"]);
      for (const h of hovers)
        expect(h.value, "translucent hover reintroduced").not.toMatch(/^primary\/\d+/);
    });

    it.each(["light", "dark"] as const)(
      "%s theme: normal and hover are both at least 4.5:1, and hover is visibly different",
      (theme) => {
        const t = themes[theme];
        const hover = hovers.find((h) => h.theme === theme)!;
        const m = /^\[color-mix\(in_oklch,var\(--primary\),var\(--([a-z-]+)\)_(\d+)%\)\]$/.exec(
          hover.value,
        );
        expect(
          m,
          `unrecognised hover background "${hover.value}": extend this contract test`,
        ).not.toBeNull();
        const normalBg = toRgb(t.primary!);
        const hoverColour = mix(t.primary!, t[m![1]!]!, Number(m![2]) / 100);
        const text = toRgb(t["primary-foreground"]!);
        expect(contrast(text, normalBg)).toBeGreaterThanOrEqual(MIN);
        expect(contrast(text, toRgb(hoverColour))).toBeGreaterThanOrEqual(MIN);
        // visibly different: the hover background moves at least 0.05 in OKLCH lightness
        expect(Math.abs(hoverColour.l - t.primary!.l)).toBeGreaterThanOrEqual(0.05);
      },
    );

    it("the original translucent hover would fail this contract (3.68:1 over white)", () => {
      const t = themes.light;
      const p = toRgb(t.primary!);
      const composited = p.map((v) => Math.round(v * 0.8 + 255 * 0.2)) as [number, number, number];
      expect(composited).toEqual([51, 149, 119]); // exactly what the browser rendered before the correction
      expect(contrast(toRgb(t["primary-foreground"]!), composited)).toBeLessThan(MIN);
    });
  },
);

describe("ToggleGroup forwards its orientation to the Base UI primitive (static)", () => {
  it("passes `orientation` to ToggleGroupPrimitive, not only to the layout attribute", () => {
    const source = read("src/components/ui/toggle-group.tsx");
    const primitive = source.slice(
      source.indexOf("<ToggleGroupPrimitive"),
      source.indexOf("</ToggleGroupPrimitive>"),
    );
    expect(primitive).toMatch(/\n\s*orientation=\{orientation\}/);
    expect(primitive).toMatch(/data-orientation=\{orientation\}/);
  });
});
