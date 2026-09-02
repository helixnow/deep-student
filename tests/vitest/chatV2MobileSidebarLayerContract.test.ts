import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('chat v2 mobile sidebar layer contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const chatPageSource = readFileSync(resolve(process.cwd(), 'src/features/chat/pages/ChatV2Page.tsx'), 'utf-8');
  const mobileLayoutSource = readFileSync(resolve(process.cwd(), 'src/components/layout/MobileSlidingLayout.tsx'), 'utf-8');
  const responsiveUtilitiesSource = readFileSync(resolve(process.cwd(), 'src/styles/responsive-utilities.css'), 'utf-8');
  const layoutHookSource = readFileSync(resolve(process.cwd(), 'src/features/chat/pages/useChatPageLayout.tsx'), 'utf-8');
  const mobileHeaderSource = readFileSync(resolve(process.cwd(), 'src/components/layout/UnifiedMobileHeader.tsx'), 'utf-8');
  const sessionSidebarSource = readFileSync(resolve(process.cwd(), 'src/features/chat/pages/SessionSidebarContent.tsx'), 'utf-8');

  it('keeps the occupying mobile header in the sliding main pane so it travels with the page', () => {
    expect(chatPageSource).toContain('viewMode, sessionSheetOpen, t, sessionCount: sessions.length,');
    expect(layoutHookSource).toContain('const isMinimalChatHeader = viewMode !== \'browser\' && isEmptyNewChat;');
    expect(layoutHookSource).toContain('title: isMinimalChatHeader ? undefined : headerTitle,');
    expect(layoutHookSource).toContain('isMinimalChatHeader\n        ? homepageNewChatAction');
    expect(layoutHookSource).toContain('sessionNewChatAction');
    expect(layoutHookSource).toContain('data-mobile-floating-menu-button');
    expect(layoutHookSource).not.toContain('DotsThreeVertical');
    expect(layoutHookSource).not.toContain('open_session_settings');
    expect(layoutHookSource).not.toContain('floatingMenuButton: isMinimalChatHeader');
    expect(layoutHookSource).not.toContain('floatingMenuButton: isMinimalChatHeader');
    expect(mobileLayoutSource).toContain('MobileInFlowHeader');
    expect(mobileHeaderSource).toContain('className="relative shrink-0"');
    expect(appSource).toContain('MobileHeaderNavProvider');
    expect(appSource).not.toContain('<UnifiedMobileHeader');
    expect(appSource).toMatch(/paddingTop: isSmallScreen\s*\n\s*\? 0/);
    expect(layoutHookSource).toContain(': () => setSessionSheetOpen(true)');
    expect(mobileHeaderSource).not.toContain('coveredByDrawer');
    expect(mobileHeaderSource).not.toContain('ctx?.drawerOpen');
    expect(mobileHeaderSource).toContain('mobile-shell-header');
    expect(mobileHeaderSource).toContain('data-mobile-shell="header"');
    expect(responsiveUtilitiesSource).toContain('var(--shell-titlebar-surface) 0%');
    expect(responsiveUtilitiesSource).toContain('transparent 100%');
    expect(responsiveUtilitiesSource).not.toContain('[data-mobile-sliding-main]');
  });

  it('pins the app launcher under drawer chrome instead of the scroll list', () => {
    expect(mobileLayoutSource).toContain('data-mobile-unified-drawer');
    expect(mobileLayoutSource).toContain('MobileUnifiedDrawerProvider');
    expect(mobileLayoutSource).toContain('sidebarFixedContent?: ReactNode');
    expect(mobileLayoutSource).toContain('data-mobile-drawer-fixed');
    expect(mobileLayoutSource).toContain('data-mobile-drawer-page');
    const chromeBlock = mobileLayoutSource.match(/data-mobile-drawer-chrome[\s\S]*?<CustomScrollArea/)?.[0] ?? '';
    expect(chromeBlock).toContain('MobileSidebarNavigation');
    expect(chromeBlock).toContain('hideSettings');
    const afterScroll = mobileLayoutSource.slice(mobileLayoutSource.indexOf('<CustomScrollArea'));
    expect(afterScroll).not.toContain('MobileSidebarNavigation');
    expect(mobileLayoutSource).not.toContain("position: 'fixed'");
    expect(mobileLayoutSource).not.toContain('overlayViewport');
    expect(mobileLayoutSource).not.toContain('useSetMobileDrawerOpen');
  });

  it('gives the mobile session drawer its own navigation surface and depth boundary', () => {
    const mobileDrawerStyleBlock = responsiveUtilitiesSource.match(
      /\[data-mobile-unified-drawer\]\s*\{[\s\S]*?\n\s*\}/,
    )?.[0] ?? '';

    expect(mobileLayoutSource).toContain('bg-[color:var(--shell-navigation-surface)]');
    expect(mobileLayoutSource).toContain('text-[color:var(--shell-navigation-foreground)]');
    expect(mobileLayoutSource).toContain('bg-[color:var(--shell-workspace-panel)]');
    expect(mobileLayoutSource).toContain('DEFAULT_DRAWER_BRAND');
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
    expect(chatPageSource).toContain('drawerHeader={renderSessionSidebarHeader()}');
    expect(chatPageSource).toContain("mobileDrawerHeader: 'fixed'");
    expect(chatPageSource).not.toContain('showSettingsFooter');
    expect(sessionSidebarSource).not.toContain('MobileSidebarNavigation');
    expect(sessionSidebarSource).not.toContain("aria-label={t('common:close')}");
    expect(sessionSidebarSource).not.toContain('<Plus size={17} weight="regular" />');
    expect(mobileLayoutSource).toContain('data-mobile-drawer-chrome');
    expect(mobileLayoutSource).toContain('settingsOnly');
    expect(mobileLayoutSource).toContain('hideSettings');
    expect(mobileLayoutSource).toContain('showContentOverlay = true');
    expect(mobileLayoutSource).toContain('drawerHeader ?? DEFAULT_DRAWER_BRAND');
    expect(mobileLayoutSource).not.toContain('showSettingsFooter &&');
  });
});
