import React from 'react';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

    // 测试环境现在会同步加载 zh-CN common 命名空间，aria-label 解析为本地化文案
    const minimizeButton = screen.getByLabelText('最小化');
    expect(minimizeButton.closest('[data-shell-window-controls]')).toBeInTheDocument();

    const mobileBackButton = screen.getByLabelText('返回');
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
