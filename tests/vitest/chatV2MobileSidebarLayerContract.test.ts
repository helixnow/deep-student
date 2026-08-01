import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('chat v2 mobile sidebar layer contract', () => {
  const chatPageSource = readFileSync(resolve(process.cwd(), 'src/features/chat/pages/ChatV2Page.tsx'), 'utf-8');
  const mobileLayoutSource = readFileSync(resolve(process.cwd(), 'src/components/layout/MobileSlidingLayout.tsx'), 'utf-8');
  const responsiveUtilitiesSource = readFileSync(resolve(process.cwd(), 'src/styles/responsive-utilities.css'), 'utf-8');
  const layoutHookSource = readFileSync(resolve(process.cwd(), 'src/features/chat/pages/useChatPageLayout.tsx'), 'utf-8');
  const mobileHeaderSource = readFileSync(resolve(process.cwd(), 'src/components/layout/UnifiedMobileHeader.tsx'), 'utf-8');
  const sessionSidebarSource = readFileSync(resolve(process.cwd(), 'src/features/chat/pages/SessionSidebarContent.tsx'), 'utf-8');

  it('coordinates the shared mobile header with the session drawer', () => {
    expect(chatPageSource).toContain('viewMode, sessionSheetOpen, t, sessionCount: sessions.length,');
    // 打开会话抽屉后由侧栏自己的顶部区接管移动视口，关闭后恢复 Chat header。
    expect(layoutHookSource).toContain('hidden: sessionSheetOpen,');
    expect(layoutHookSource).toContain('const isMinimalChatHeader = viewMode !== \'browser\' && isEmptyNewChat;');
    expect(layoutHookSource).toContain('title: isMinimalChatHeader ? undefined : headerTitle,');
    expect(layoutHookSource).toContain('floatingMenuButton: isMinimalChatHeader,');
    expect(layoutHookSource).toContain('rightActions: isMinimalChatHeader ? undefined : headerRightActions,');
    expect(layoutHookSource).toContain('? () => setSessionSheetOpen(false)');
    expect(layoutHookSource).toContain(': () => setSessionSheetOpen(true)');
    expect(mobileHeaderSource).toContain('if (config.hidden) {');
    expect(mobileHeaderSource).toContain('mobile-shell-header');
    expect(mobileHeaderSource).toContain('data-mobile-shell="floating-sidebar-trigger"');
    expect(mobileHeaderSource).toContain('data-mobile-floating-menu-button');
    expect(responsiveUtilitiesSource).toContain('var(--shell-titlebar-surface) 0%');
    expect(responsiveUtilitiesSource).toContain('transparent 100%');
    expect(responsiveUtilitiesSource).toContain("[data-mobile-shell='floating-sidebar-trigger']");
  });

  it('uses a unified scroll drawer for page sidebar and app navigation on mobile', () => {
    expect(mobileLayoutSource).toContain('data-mobile-unified-drawer');
    expect(mobileLayoutSource).toContain('MobileUnifiedDrawerProvider');
    expect(mobileLayoutSource).toContain('sidebarFixedContent?: ReactNode');
    expect(mobileLayoutSource).toContain('data-mobile-drawer-fixed');
    expect(mobileLayoutSource).toContain('embedded');
    expect(mobileLayoutSource).toContain('data-mobile-drawer-page');
    expect(mobileLayoutSource).not.toContain('zIndex: Z_INDEX.drawer');
  });

  it('gives the mobile session drawer its own navigation surface and depth boundary', () => {
    const mobileDrawerStyleBlock = responsiveUtilitiesSource.match(
      /\[data-mobile-unified-drawer\]\s*\{[\s\S]*?\n\s*\}/,
    )?.[0] ?? '';

    expect(mobileLayoutSource).toContain('bg-[color:var(--shell-navigation-surface)]');
    expect(mobileLayoutSource).toContain('text-[color:var(--shell-navigation-foreground)]');
    expect(mobileLayoutSource).toContain('bg-[color:var(--shell-workspace-panel)]');
    expect(mobileLayoutSource).toContain('useMobileHeaderContextSafe');
    expect(mobileLayoutSource).toContain('pt-[calc(0.5rem+var(--mobile-safe-area-top,0px))]');
    expect(mobileDrawerStyleBlock).toContain('background: var(--shell-navigation-surface) !important;');
    expect(mobileDrawerStyleBlock).toContain('border-right: 1px solid var(--shell-navigation-border) !important;');
    expect(mobileDrawerStyleBlock).toContain('box-shadow: 8px 0 24px -18px hsl(var(--shadow-base) / 0.48) !important;');
    expect(mobileDrawerStyleBlock).not.toContain('background: hsl(var(--background)) !important;');
    expect(mobileDrawerStyleBlock).not.toContain('box-shadow: none !important;');
  });

  it('keeps the mobile session drawer controls pinned above its scrollable content', () => {
    expect(sessionSidebarSource).toContain('data-mobile-sidebar-fixed-region="top"');
    expect(sessionSidebarSource).toContain("mobileDrawerHeader?: 'inline' | 'fixed'");
    expect(sessionSidebarSource).not.toContain('sticky top-0 z-10');
    expect(sessionSidebarSource).toContain('bg-[color:var(--shell-navigation-surface)]');
    expect(chatPageSource).toContain('sidebarFixedContent={renderSessionSidebarHeader()}');
    expect(chatPageSource).toContain("mobileDrawerHeader: 'fixed'");
  });
});
