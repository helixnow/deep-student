import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import { BottomTabBar } from '@/components/layout/BottomTabBar';
import { MobileHeaderProvider } from '@/components/layout/MobileHeaderContext';
import { UnifiedMobileHeader } from '@/components/layout/UnifiedMobileHeader';

test('mounts mobile study shell chrome primitives', async ({ mount }) => {
  const component = await mount(
    <div style={{ width: 390, minHeight: 844, background: 'var(--surface-root)', position: 'relative' }}>
      <MobileHeaderProvider>
        <UnifiedMobileHeader canGoBack onBack={() => undefined} />
      </MobileHeaderProvider>

      <BottomTabBar currentView="chat-v2" onViewChange={() => undefined} />
    </div>
  );

  await expect(component.locator('[data-mobile-shell="header"]')).toBeVisible();
  await expect(component.locator('[data-mobile-shell="tabbar"]')).toBeVisible();
  await expect(component.locator('[role="tab"][aria-selected="true"]')).toHaveCount(1);
});
