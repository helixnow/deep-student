import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const themeSource = readFileSync(
  resolve(process.cwd(), 'src/styles/theme-colors.css'),
  'utf-8',
);
const tailwindSource = readFileSync(
  resolve(process.cwd(), 'tailwind.config.js'),
  'utf-8',
);

function blockOf(selector: string): string {
  const start = themeSource.indexOf(`${selector} {`);
  expect(start, `${selector} should exist in theme-colors.css`).toBeGreaterThan(-1);
  return themeSource.slice(start, themeSource.indexOf('\n}', start));
}

function declarationOf(block: string, token: string): string | undefined {
  return block.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1]?.trim();
}

describe('brand color token contract', () => {
  const lightRoot = blockOf(':where(:root)');
  const darkRoot = blockOf(':root.dark');

  it('defines complete colors for every Tailwind brand mapping', () => {
    expect(tailwindSource).toContain("secondary: 'var(--brand-secondary)'");
    expect(tailwindSource).toContain("accent: 'var(--brand-accent)'");

    for (const token of ['--brand-secondary', '--brand-accent']) {
      expect(declarationOf(lightRoot, token)).toMatch(/hsl\(|color-mix\(/);
      expect(declarationOf(darkRoot, token)).toMatch(/hsl\(|color-mix\(/);
    }
  });
});
