import React from 'react';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import zhCommon from '@/locales/zh-CN/common.json';
import { WindowControls } from '@/components/WindowControls';
import { MobileHeaderProvider } from '@/components/layout/MobileHeaderContext';
import { UnifiedMobileHeader } from '@/components/layout/UnifiedMobileHeader';
import {
  UnifiedSidebar,
  UnifiedSidebarContent,
  UnifiedSidebarFooter,
  UnifiedSidebarHeader,
  UnifiedSidebarItem,
} from '@/components/ui/unified-sidebar/UnifiedSidebar';

function createMatchMedia(matches = false): typeof window.matchMedia {
  return ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as typeof window.matchMedia;
}

describe('ui shell smoke render', () => {
  const originalMatchMedia = window.matchMedia;

  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: createMatchMedia(false),
    });
  });

  afterAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
  });

  it('renders desktop and mobile chrome primitives with shell semantics', () => {
    render(
      <>
        <WindowControls />
        <MobileHeaderProvider>
          <UnifiedMobileHeader canGoBack onBack={() => undefined} />
        </MobileHeaderProvider>
      </>
    );

    // i18n mock（tests/ct/mocks/react-i18next.tsx）会解析 zh-CN 语言包，
    // 因此按解析后的文案断言，而不是原始 key。
    const minimizeButton = screen.getByLabelText(zhCommon.window_controls.minimize);
    expect(minimizeButton.closest('[data-shell-window-controls]')).toBeInTheDocument();

    const mobileBackButton = screen.getByLabelText(zhCommon.mobile_header.back);
    expect(mobileBackButton.closest('[data-mobile-shell="header"]')).toBeInTheDocument();
  });

  it('renders unified sidebar search, selected rows, and footer through shell wrappers', () => {
    render(
      <UnifiedSidebar width={240} autoResponsive={false}>
        <UnifiedSidebarHeader title="Library" searchPlaceholder="Search skills" showCollapse={false} />
        <UnifiedSidebarContent>
          <UnifiedSidebarItem id="alpha" title="Alpha" isSelected onClick={() => undefined} />
        </UnifiedSidebarContent>
        <UnifiedSidebarFooter>Footer action</UnifiedSidebarFooter>
      </UnifiedSidebar>
    );

    expect(screen.getByPlaceholderText('Search skills')).toBeInTheDocument();
    expect(screen.getByRole('button', { pressed: true })).toHaveAttribute('data-selected', 'true');
    expect(screen.getByText('Footer action')).toBeInTheDocument();
  });
});
