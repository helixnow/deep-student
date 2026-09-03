import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

describe('settings data-governance mobile lists', () => {
  it.each([
    'BackupTab.tsx',
    'SyncTab.tsx',
    'AuditTab.tsx',
    'OverviewTab.tsx',
  ])('keeps the wide table on desktop and renders cards below md in %s', (file) => {
    const source = readSource(`src/features/settings/components/data-governance/${file}`);

    expect(source).toContain('className="hidden md:block"');
    expect(source).toContain('className="space-y-2 md:hidden"');
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
