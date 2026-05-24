import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('topbar tooltip contract', () => {
  const topbarSource = readFileSync(resolve(process.cwd(), 'src/components/layout/Topbar.tsx'), 'utf-8');

  it('uses CommonTooltip for the sidebar toggle instead of native title', () => {
    expect(topbarSource).toContain("import { CommonTooltip } from '@/components/shared/CommonTooltip';");
    expect(topbarSource).toContain('const sidebarToggleLabel = sidebarCollapsed');
    expect(topbarSource).toContain('<CommonTooltip content={sidebarToggleLabel} position="bottom">');
    expect(topbarSource).toContain('aria-label={sidebarToggleLabel}');
    expect(topbarSource).not.toContain('title={sidebarCollapsed');
  });
});
