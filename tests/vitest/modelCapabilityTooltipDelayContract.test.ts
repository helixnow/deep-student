import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ModelCapabilityIcons tooltip delay contract', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/shared/ModelCapabilityIcons.tsx'), 'utf-8');

  it('lets CommonTooltip use the shared hover-intent delay instead of overriding it with an eager delay', () => {
    expect(source).toContain('<CommonTooltip key={label} content={label} position="top">');
    expect(source).not.toMatch(/delay=\{\s*(?:0|[1-4]\d{0,2})\s*\}/);
    expect(source).not.toContain('title={label}');
  });
});
