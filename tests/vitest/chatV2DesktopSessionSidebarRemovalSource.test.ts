import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ChatV2Page desktop session sidebar removal', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/chat-v2/pages/ChatV2Page.tsx'), 'utf-8');

  it('does not render the desktop UnifiedSidebar session rail', () => {
    expect(source).not.toContain('<UnifiedSidebar');
    expect(source).not.toContain('<UnifiedSidebarHeader');
    expect(source).not.toContain('<UnifiedSidebarContent');
  });

  it('keeps SessionBrowser for browser mode only', () => {
    expect(source).toContain("viewMode === 'browser' && !isSmallScreen ? (");
    expect(source).toContain('<SessionBrowser');
  });
});
