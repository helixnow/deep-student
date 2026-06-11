import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import { MobileHeaderProvider } from '@/components/layout/MobileHeaderContext';
import { UnifiedMobileHeader } from '@/components/layout/UnifiedMobileHeader';

test('mounts mobile study shell chrome primitives', async ({ mount }) => {
  const component = await mount(
    <div style={{ width: 390, minHeight: 844, background: 'var(--surface-root)', position: 'relative' }}>
      <MobileHeaderProvider>
        <UnifiedMobileHeader canGoBack onBack={() => undefined} />
      </MobileHeaderProvider>
    </div>
  );

  await expect(component.locator('[data-mobile-shell="header"]')).toBeVisible();
});
