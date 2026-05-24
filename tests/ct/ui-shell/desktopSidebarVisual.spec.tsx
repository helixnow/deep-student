import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import { ModernSidebar } from '@/components/ModernSidebar';

test('renders desktop sidebar with study-ui style nav icons', async ({ mount }) => {
  const component = await mount(
    <div
      data-theme="light"
      style={{
        width: 272,
        minHeight: 900,
        background: 'var(--shell-navigation-panel)',
      }}
    >
      <ModernSidebar
        currentView="chat-v2"
        onViewChange={() => undefined}
      />
    </div>
  );

  const sidebar = component.locator('aside[role="navigation"]');
  await expect(sidebar).toBeVisible();
  await sidebar.screenshot({ path: '/tmp/deepstudent-modern-sidebar-ct.png' });
});
