import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat streaming preference contract', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/features/chat/pages/ChatV2Page.tsx'), 'utf-8');

  it('wraps chat v2 with balanced stream preferences', () => {
    expect(source).toContain('<StreamPreferencesProvider preset="balanced" mode="blocked">');
    expect(source).toContain('</StreamPreferencesProvider>');
  });
});
