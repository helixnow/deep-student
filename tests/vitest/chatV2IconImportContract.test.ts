import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ChatV2 icon import contract', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/chat-v2/pages/ChatV2Page.tsx'), 'utf-8');

  it('imports Settings when the settings icon is rendered in JSX', () => {
    expect(source).toContain('<Settings className="w-3.5 h-3.5" />');
    expect(source).toMatch(/import\s*\{[^}]*\bSettings\b[^}]*\}\s*from 'lucide-react';/);
  });
});
