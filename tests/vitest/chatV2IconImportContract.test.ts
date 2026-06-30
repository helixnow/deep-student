import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ChatV2 icon import contract', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/features/chat/pages/ChatV2Page.tsx'), 'utf-8');

  it('keeps ChatV2 page icons on the active Phosphor import set', () => {
    expect(source).toMatch(/import\s*\{[^}]*\bChat\b[^}]*\bBooks\b[^}]*\bArrowSquareOut\b[^}]*\}\s*from '@phosphor-icons\/react';/);
    expect(source).not.toContain('<Settings className="w-3.5 h-3.5" />');
    expect(source).not.toContain("from 'lucide-react'");
  });
});
