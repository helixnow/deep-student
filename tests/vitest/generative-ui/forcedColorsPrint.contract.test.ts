/**
 * Contract: generative-ui.css ships Round 45 forced-colors + print rules.
 * Reads the stylesheet as text (no DOM render).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CSS_PATH = path.join(process.cwd(), 'src/features/generative-ui/generative-ui.css');

function readCss(): string {
  return fs.readFileSync(CSS_PATH, 'utf8');
}

function mediaBlock(css: string, query: string): string {
  const marker = `@media ${query}`;
  const start = css.indexOf(marker);
  expect(start, `expected ${marker} in generative-ui.css`).toBeGreaterThan(-1);

  const open = css.indexOf('{', start);
  expect(open, `expected opening brace for ${marker}`).toBeGreaterThan(start);

  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }

  throw new Error(`unclosed ${marker} block`);
}

describe('forcedColorsPrint.contract — generative-ui.css', () => {
  it('contains forced-colors and print media queries', () => {
    const css = readCss();
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain('@media print');
    expect(css).toContain('@media (prefers-contrast: more)');
  });

  it('forced-colors maps buttons/links/focus to system colors', () => {
    const block = mediaBlock(readCss(), '(forced-colors: active)');
    expect(block).toMatch(/CanvasText|Highlight/);
    expect(block).toContain('[data-generative-ui]');
    expect(block).toMatch(/outline:\s*2px\s+solid\s+(?:Highlight|CanvasText)/);
    expect(block).toContain('forced-color-adjust: auto');
  });

  it('print hides chrome and toolbar, keeps block slots from splitting', () => {
    const block = mediaBlock(readCss(), 'print');
    expect(block).toContain('data-generative-ui-chrome');
    expect(block).toMatch(/\[role=['"]toolbar['"]\]/);
    expect(block).toContain('display: none');
    expect(block).toMatch(/\[data-generative-block\][^{]*\{[^}]*break-inside:\s*avoid/);
  });
});
