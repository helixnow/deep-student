import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 flowtoken fade contract', () => {
  const markdownCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/styles/markdown.css'),
    'utf-8',
  );

  it('defines scoped fade-in tuning for flowtoken spans', () => {
    expect(markdownCssSource).toContain('.flowtoken-markdown span[style*="animation-name: ft-fadeIn"]');
    expect(markdownCssSource).toContain('will-change: opacity;');
    expect(markdownCssSource).not.toContain('ds-flowtoken-blur-in');
    expect(markdownCssSource).not.toContain('filter: blur(1.6px);');
  });
});
