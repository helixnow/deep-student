import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('UserAgreementDialog icon contract', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/legal/UserAgreementDialog.tsx'), 'utf-8');

  it('uses the Phosphor caret for legal section toggles', () => {
    expect(source).toContain("import { CaretRight } from '@phosphor-icons/react';");
    expect(source).toContain('<CaretRight');
    expect(source).toContain('weight="regular"');
    expect(source).not.toContain("from 'lucide-react'");
    expect(source).not.toContain('<ChevronRight');
  });
});
