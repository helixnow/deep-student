import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

describe('settings data-governance mobile lists', () => {
  it.each([
    'BackupTab.tsx',
    'SyncTab.tsx',
    'AuditTab.tsx',
  ])('keeps the wide table on desktop and renders cards below md in %s', (file) => {
    const source = readSource(`src/features/settings/components/data-governance/${file}`);

    expect(source).toContain('className="hidden md:block"');
    expect(source).toContain('className="space-y-2 rounded-2xl bg-muted p-4 md:hidden"');
  });

  it('keeps the wide table on desktop and renders a grouped inset list below md in OverviewTab.tsx', () => {
    const source = readSource('src/features/settings/components/data-governance/OverviewTab.tsx');

    expect(source).toContain('className="hidden md:block"');
    expect(source).toContain('className="divide-y divide-border/40 overflow-hidden rounded-2xl bg-muted md:hidden"');
  });

  it.each([
    'SyncTab.tsx',
    'AuditTab.tsx',
    'OverviewTab.tsx',
  ])('does not hand-patch coarse 44px button heights in %s', (file) => {
    const source = readSource(`src/features/settings/components/data-governance/${file}`);

    expect(source).not.toContain('[@media(pointer:coarse)]:!min-h-11');
    expect(source).not.toContain('[@media(pointer:coarse)]:!min-h-[44px]');
  });
});
