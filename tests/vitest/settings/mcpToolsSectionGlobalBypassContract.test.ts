import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('mcp tools section global bypass contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/settings/components/McpToolsSection.tsx'),
    'utf-8'
  );

  it('uses the shared switch control instead of an oversized icon-only button for global bypass', () => {
    expect(source).toContain("import { Switch } from '../ui/shad/Switch';");
    expect(source).toContain('<Switch');
    expect(source).toContain('checked={globalBypass}');
    expect(source).toContain('onCheckedChange={handleToggleGlobalBypass}');
    expect(source).not.toContain('!h-auto !w-auto');
    expect(source).not.toContain('h-7 w-12');
    expect(source).not.toContain('<ToggleLeft');
    expect(source).not.toContain('<ToggleRight');
  });

  it('styles the global bypass card as an interactive settings control with active and inactive states', () => {
    expect(source).toContain(
      `cn(
              'p-4 rounded-lg border transition-colors duration-200'`
    );
    expect(source).toContain(
      `globalBypass
                ? 'border-primary/30 bg-primary/5'`
    );
    expect(source).toContain(
      `: 'border-border/40 bg-muted/20 hover:border-border/60'`
    );
    expect(source).toContain(
      `data-[state=unchecked]:bg-[color:var(--surface-panel-strong)]`
    );
    expect(source).toContain(
      `data-[state=unchecked]:ring-1 data-[state=unchecked]:ring-[color:var(--button-utility-border)]`
    );
  });
});
