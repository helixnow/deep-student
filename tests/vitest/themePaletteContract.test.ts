import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'src/styles/shadcn-variables.css'), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const accentPalettes = ['purple', 'green', 'orange', 'pink', 'teal'] as const;
const allPalettes = ['default', ...accentPalettes, 'muted', 'paper'] as const;

function getRuleVars(selector: string) {
  const vars: Record<string, string> = {};
  const rulePattern = /([^{}]+)\{([\s\S]*?)\}/g;

  for (const match of source.matchAll(rulePattern)) {
    const selectors = match[1].split(',').map((item) => item.trim());
    if (!selectors.includes(selector)) continue;

    for (const varMatch of match[2].matchAll(/--([\w-]+):\s*([^;]+);/g)) {
      vars[varMatch[1]] = varMatch[2].trim();
    }
  }

  return vars;
}

const lightBaseVars = getRuleVars(':root');
const darkBaseVars = getRuleVars(':root.dark');

function getPaletteVars(palette: string, mode: 'light' | 'dark') {
  const baseVars = mode === 'dark' ? darkBaseVars : lightBaseVars;
  const selector =
    mode === 'dark'
      ? `:root.dark[data-theme-palette='${palette}']`
      : `:root[data-theme-palette='${palette}']`;

  return {
    ...baseVars,
    ...getRuleVars(selector),
  };
}

function hslToRgb(value: string) {
  const parts = value.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
  if (!parts || parts.length < 3) {
    throw new Error(`Expected an HSL token, received: ${value}`);
  }

  let [hue, saturation, lightness] = parts;
  hue = ((hue % 360) + 360) % 360;
  saturation /= 100;
  lightness /= 100;

  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const second = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const match = lightness - chroma / 2;
  let red = 0;
  let green = 0;
  let blue = 0;

  if (hue < 60) {
    red = chroma;
    green = second;
  } else if (hue < 120) {
    red = second;
    green = chroma;
  } else if (hue < 180) {
    green = chroma;
    blue = second;
  } else if (hue < 240) {
    green = second;
    blue = chroma;
  } else if (hue < 300) {
    red = second;
    blue = chroma;
  } else {
    red = chroma;
    blue = second;
  }

  return [red + match, green + match, blue + match].map((channel) => Math.round(channel * 255));
}

function toLinear(channel: number) {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb: number[]) {
  const [red, green, blue] = rgb.map(toLinear);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(a: string, b: string) {
  const first = luminance(hslToRgb(a));
  const second = luminance(hslToRgb(b));

  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe('theme palette contract', () => {
  it('keeps primary foreground contrast readable across curated palettes', () => {
    for (const palette of allPalettes) {
      for (const mode of ['light', 'dark'] as const) {
        const vars = getPaletteVars(palette, mode);

        expect(
          contrastRatio(vars.primary, vars['primary-foreground']),
          `${palette}/${mode} primary foreground contrast`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('uses accent palettes as accents instead of recoloring every neutral surface', () => {
    const surfaceTokens = [
      'titlebar-background',
      'nav-background',
      'background',
      'foreground',
      'card',
      'popover',
      'secondary',
      'muted',
      'accent',
      'border',
      'input',
    ];

    for (const palette of accentPalettes) {
      for (const mode of ['light', 'dark'] as const) {
        const selector =
          mode === 'dark'
            ? `:root.dark[data-theme-palette='${palette}']`
            : `:root[data-theme-palette='${palette}']`;
        const vars = getRuleVars(selector);

        for (const token of surfaceTokens) {
          expect(vars, `${selector} should inherit neutral token --${token}`).not.toHaveProperty(token);
        }
      }
    }
  });
});
