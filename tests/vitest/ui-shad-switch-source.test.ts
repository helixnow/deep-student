import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('shared shad switch source contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/components/ui/shad/Switch.tsx'),
    'utf-8'
  );

  it('owns its sizing and state styles in the component instead of a legacy css override file', () => {
    expect(source).not.toContain("import './Switch.css';");
    expect(source).not.toContain('data-shad-switch=""');
    expect(source).toContain('h-5 w-9');
    expect(source).toContain('p-[2px]');
    expect(source).toContain('data-[state=checked]:bg-[color:var(--button-primary-foreground)]');
    expect(source).toContain('data-[state=unchecked]:bg-[color:var(--button-utility-surface)]');
  });

  it('defines thumb size and travel inline so className overrides remain predictable', () => {
    expect(source).toContain('h-4 w-4');
    expect(source).toContain('data-[state=checked]:translate-x-4');
    expect(source).toContain('data-[state=unchecked]:translate-x-0');
    expect(source).not.toContain('!important');
  });
});
