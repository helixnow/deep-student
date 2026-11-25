import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getFontFamilyByValue, MATH_SYMBOL_FALLBACK_FONTS } from '@/config/fontConfig';

const readStyle = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

describe('math symbol font fallback stack (U+2260 ≠ and Unicode math operators)', () => {
  const REQUIRED_MATH_FALLBACKS = [
    'Noto Sans Math',
    'DejaVu Sans',
    'Liberation Sans',
    'KaTeX_Main',
    'Apple Symbols',
    'Segoe UI Symbol',
    'Cambria Math',
    'Symbola',
  ];

  it('defines --font-math-fallback and wires it before generic fallbacks in shadcn-variables.css', () => {
    const css = readStyle('src/styles/shadcn-variables.css');
    const mathVarMatch = css.match(/--font-math-fallback:\s*([^;]+);/);
    expect(mathVarMatch).not.toBeNull();
    const mathVarValue = mathVarMatch![1];
    for (const fontName of REQUIRED_MATH_FALLBACKS) {
      expect(mathVarValue).toContain(fontName);
    }

    for (const token of ['--font-family', '--font-family-cn', '--app-font-family', '--font-mono']) {
      const tokenMatch = css.match(new RegExp(`${token}:\\s*([^;]+);`));
      expect(tokenMatch, `missing ${token}`).not.toBeNull();
      const value = tokenMatch![1];
      const fallbackIdx = value.indexOf('var(--font-math-fallback)');
      const genericMatch = value.match(/(?:^|,\s*)(sans-serif|monospace)(?=\s*,|\s*$)/);
      expect(fallbackIdx).toBeGreaterThan(-1);
      expect(genericMatch).not.toBeNull();
      expect(genericMatch!.index!).toBeGreaterThan(fallbackIdx);
    }
  });

  it('includes --font-math-fallback in typography.css, tailwind.css, prose-lite.css, and notes-typography.css', () => {
    for (const file of [
      'src/styles/typography.css',
      'src/styles/tailwind.css',
      'src/styles/prose-lite.css',
      'src/styles/notes-typography.css',
    ]) {
      expect(readStyle(file), `${file} should reference --font-math-fallback`).toContain(
        'var(--font-math-fallback)',
      );
    }
  });

  it('keeps math symbol fallbacks before generic family after runtime applyFontToDocument presets', () => {
    for (const preset of ['system', 'inter', 'pingfang', 'noto-sans', 'noto-serif', 'mono']) {
      const family = getFontFamilyByValue(preset);
      const mathIdx = family.indexOf(MATH_SYMBOL_FALLBACK_FONTS);
      const genericIdx = family.search(/,\s*(sans-serif|serif|monospace|cursive)\s*$/);
      expect(mathIdx, `preset ${preset} missing math fallbacks`).toBeGreaterThan(-1);
      expect(genericIdx, `preset ${preset} missing generic family`).toBeGreaterThan(mathIdx);
    }
  });
});
