import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('chat v2 mobile sidebar layer contract', () => {
  const chatPageSource = readFileSync(resolve(process.cwd(), 'src/features/chat/pages/ChatV2Page.tsx'), 'utf-8');
  const mobileLayoutSource = readFileSync(resolve(process.cwd(), 'src/components/layout/MobileSlidingLayout.tsx'), 'utf-8');
  const layoutHookSource = readFileSync(resolve(process.cwd(), 'src/features/chat/pages/useChatPageLayout.tsx'), 'utf-8');
  const mobileHeaderSource = readFileSync(resolve(process.cwd(), 'src/components/layout/UnifiedMobileHeader.tsx'), 'utf-8');

  it('hides the shared mobile header while the chat session sidebar is open', () => {
    expect(chatPageSource).toContain('viewMode, sessionSheetOpen, t, sessionCount: sessions.length,');
    expect(layoutHookSource).toContain('hidden: sessionSheetOpen,');
    expect(mobileHeaderSource).toContain('if (config.hidden) {');
  });

  it('keeps the mobile sliding shell on the shared drawer layer', () => {
    expect(mobileLayoutSource).toContain('zIndex: Z_INDEX.drawer');
    expect(mobileLayoutSource).toContain('relative z-[2] flex h-full min-h-0 flex-shrink-0 flex-col');
  });
});
