import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('UserAgreementDialog preview scroll contract', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/legal/UserAgreementDialog.tsx'), 'utf-8');

  it('uses a native scroll container for long agreement content inside the preview modal', () => {
    expect(source).toContain('overflow-y-auto overscroll-contain');
    expect(source).toContain('scroll-area--native');
    expect(source).toContain('onWheel={(e) => e.stopPropagation()}');
    expect(source).not.toContain("import { CustomScrollArea } from '@/components/custom-scroll-area';");
    expect(source).not.toContain('<CustomScrollArea');
  });
});
