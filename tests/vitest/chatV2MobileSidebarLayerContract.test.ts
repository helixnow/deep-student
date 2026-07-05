import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('chat v2 mobile sidebar layer contract', () => {
  const chatPageSource = readFileSync(resolve(process.cwd(), 'src/features/chat/pages/ChatV2Page.tsx'), 'utf-8');
  const mobileLayoutSource = readFileSync(resolve(process.cwd(), 'src/components/layout/MobileSlidingLayout.tsx'), 'utf-8');
  const layoutHookSource = readFileSync(resolve(process.cwd(), 'src/features/chat/pages/useChatPageLayout.tsx'), 'utf-8');
  const mobileHeaderSource = readFileSync(resolve(process.cwd(), 'src/components/layout/UnifiedMobileHeader.tsx'), 'utf-8');

  it('keeps the shared mobile header visible and lets the menu button toggle the session drawer', () => {
    expect(chatPageSource).toContain('viewMode, sessionSheetOpen, t, sessionCount: sessions.length,');
    // 统一抽屉设计：抽屉在顶栏下方滑出，顶栏保持可见，汉堡按钮承担开/关切换
    expect(layoutHookSource).toContain('? () => setSessionSheetOpen(false)');
    expect(layoutHookSource).toContain(': () => setSessionSheetOpen(true)');
    expect(layoutHookSource).not.toContain('hidden: sessionSheetOpen,');
    expect(mobileHeaderSource).toContain('if (config.hidden) {');
  });

  it('uses a unified scroll drawer for page sidebar and app navigation on mobile', () => {
    expect(mobileLayoutSource).toContain('data-mobile-unified-drawer');
    expect(mobileLayoutSource).toContain('MobileUnifiedDrawerProvider');
    expect(mobileLayoutSource).toContain('embedded');
    expect(mobileLayoutSource).toContain('data-mobile-drawer-page');
    expect(mobileLayoutSource).not.toContain('zIndex: Z_INDEX.drawer');
  });
});
