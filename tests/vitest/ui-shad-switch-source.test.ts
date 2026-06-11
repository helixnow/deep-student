import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('shared shad switch source contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/components/ui/shad/Switch.tsx'),
    'utf-8'
  );
  const cssSource = readFileSync(
    resolve(process.cwd(), 'src/components/ui/shad/Switch.css'),
    'utf-8'
  );
  const cssDeclarations = cssSource.replace(/\/\*[\s\S]*?\*\//g, '');

  it('owns its sizing and state styles through the shared switch stylesheet instead of legacy overrides', () => {
    expect(source).toContain('import "./Switch.css"');
    expect(source).not.toContain('data-shad-switch=""');
    expect(cssSource).toContain('height: 1.5rem');
    expect(cssSource).toContain('width: 2.75rem');
    expect(cssSource).toContain('padding: 2px');
    expect(cssSource).toContain('background-color: hsl(var(--primary))');
  });

  it('defines thumb size and travel in tokenized selectors without important overrides', () => {
    expect(cssSource).toContain('height: 1.25rem');
    expect(cssSource).toContain('width: 1.25rem');
    expect(cssSource).toContain('transform: translateX(1.25rem)');
    expect(cssSource).toContain('transform: translateX(0.75rem)');
    expect(cssDeclarations).not.toContain('!important');
  });
});
