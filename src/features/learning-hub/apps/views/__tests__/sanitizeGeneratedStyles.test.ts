import { describe, expect, it } from 'vitest';
import { sanitizeDocxGeneratedStyles } from '../sanitizeGeneratedStyles';

describe('sanitizeDocxGeneratedStyles', () => {
  it('scopes document rules and removes external URLs', () => {
    const source = document.createElement('div');
    source.innerHTML = `<style>
      .docx p { color: red; background-image: url(https://attacker.invalid/pixel); }
      body { display: none; }
      @font-face { font-family: Safe; src: url(data:font/woff;base64,AA==); }
    </style>`;

    const css = sanitizeDocxGeneratedStyles(source).map((style) => style.textContent).join('\n');
    expect(css).toContain('.docx-content-wrapper .docx p');
    expect(css).toContain('.docx-content-wrapper body');
    expect(css).not.toContain('attacker.invalid');
    expect(css).toContain('data:font/woff');
    expect(css).not.toMatch(/(^|})\s*body\s*\{/);
  });
});
