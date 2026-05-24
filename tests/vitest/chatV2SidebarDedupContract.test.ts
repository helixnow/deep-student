import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ChatV2 sidebar dedup contract', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/chat-v2/pages/ChatV2Page.tsx'), 'utf-8');

  it('does not duplicate shell destinations inside the chat sidebar', () => {
    expect(source).not.toContain("navigateToShellView('learning-hub')");
    expect(source).not.toContain("navigateToShellView('skills-management')");
    expect(source).not.toContain("navigateToShellView('settings')");
  });
});
