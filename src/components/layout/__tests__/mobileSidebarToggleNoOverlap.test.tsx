import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dstuMocks = vi.hoisted(() => ({
  list: vi.fn(),
  createEmpty: vi.fn(),
  watch: vi.fn(),
}));

vi.mock('@/dstu', () => ({
  dstu: { list: dstuMocks.list, watch: dstuMocks.watch },
  createEmpty: dstuMocks.createEmpty,
}));

vi.mock('@/features/learning-hub/apps/UnifiedAppPanel', () => ({
  default: ({ type, resourceId }: { type: string; resourceId: string }) => (
    <div data-testid="resource-content">
      {type}:{resourceId}
    </div>
  ),
}));

import {
  MobileHeaderProvider,
  MobileLayoutProvider,
  MobilePageScaffold,
  UnifiedMobileHeader,
  useMobileHeader,
} from '@/components/layout';
import { ResourceAppWorkspace } from '@/features/workbench/apps/content/ResourceAppWorkspace';

function mockViewport(width: number, height = 800) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: height,
  });
  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    const clauses = query.split(/\s+and\s+/i);
    const matches = clauses.every((clause) => {
      const minW = clause.match(/min-width:\s*(\d+)px/);
      if (minW) return width >= Number(minW[1]);
      const maxW = clause.match(/max-width:\s*(\d+)px/);
      if (maxW) return width <= Number(maxW[1]);
      const maxH = clause.match(/max-height:\s*(\d+)px/);
      if (maxH) return height <= Number(maxH[1]);
      if (/orientation:\s*landscape/i.test(clause)) return width > height;
      if (/orientation:\s*portrait/i.test(clause)) return height >= width;
      return false;
    });
    return {
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList;
  });
}

function FloatingMenuTriggerHost({ onMenuClick }: { onMenuClick: () => void }) {
  useMobileHeader(
    'essay-test',
    {
      showMenu: true,
      floatingMenuButton: true,
      onMenuClick,
    },
    [onMenuClick],
  );
  return <div data-testid="mobile-body">作文批改正文内容</div>;
}

describe('360px mobile sidebar toggle non-overlapping layout (S3-17)', () => {
  beforeEach(() => {
    mockViewport(360, 800);
    dstuMocks.list.mockReset().mockResolvedValue({
      ok: true,
      value: [
        {
          id: 'essay-1',
          sourceId: 'essay-1',
          path: '/essay-1',
          name: 'CET-6 Essay',
          type: 'essay' as const,
          createdAt: 1,
          updatedAt: Date.now(),
        },
      ],
    });
    dstuMocks.watch.mockReset().mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.querySelectorAll('[data-wb-titlebar-slot]').forEach((el) => el.remove());
  });

  it('keeps UnifiedMobileHeader in-flow with reserved height and >=44px tap target in floatingMenuButton mode', async () => {
    const onMenuClick = vi.fn();
    const { container } = render(
      <UnifiedMobileHeader
        configOverride={{
          showMenu: true,
          floatingMenuButton: true,
          onMenuClick,
        }}
      />,
    );

    const bar = container.querySelector('[data-mobile-shell="floating-sidebar-trigger"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.className).toContain('relative');
    expect(bar.className).toContain('shrink-0');
    expect(bar.className).not.toContain('fixed');
    expect(bar.className).not.toContain('absolute');
    await waitFor(() => {
      expect(bar.className).not.toContain('pointer-events-none');
    });
    expect(bar.style.minHeight).toContain('--mobile-header-total-height');
    expect(bar.style.height).toContain('--mobile-header-total-height');

    const toggle = container.querySelector('[data-mobile-floating-menu-button]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.className).toContain('min-h-11');
    expect(toggle.className).toContain('min-w-11');

    fireEvent.click(toggle);
    expect(onMenuClick).toHaveBeenCalledTimes(1);
  });

  it('places MobilePageScaffold header above content in a vertical flex flow at 360px', () => {
    const onMenuClick = vi.fn();
    const { container } = render(
      <MobileLayoutProvider>
        <MobileHeaderProvider>
          <MobilePageScaffold>
            <FloatingMenuTriggerHost onMenuClick={onMenuClick} />
          </MobilePageScaffold>
        </MobileHeaderProvider>
      </MobileLayoutProvider>,
    );

    const header = container.querySelector('[data-mobile-shell="header"], [data-mobile-shell="floating-sidebar-trigger"]') as HTMLElement;
    const body = screen.getByTestId('mobile-body');
    expect(header).not.toBeNull();
    expect(header.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(header.parentElement?.className).toContain('flex-col');
  });

  it('never mounts the desktop fixed "切换边栏" accessory at 360px and keeps WindowTitleBar toggle clear of title text', () => {
    const appShellSource = readFileSync(
      resolve(process.cwd(), 'src/app/shell/AppShellChrome.tsx'),
      'utf8',
    );
    expect(appShellSource).toContain('{!isSmallScreen && !workbenchActive && (');

    const titleBarCss = readFileSync(
      resolve(process.cwd(), 'src/features/workbench/components/WindowTitleBar.css'),
      'utf8',
    );
    const mobileIdx = titleBarCss.indexOf('@media (pointer: coarse), (max-width: 640px)');
    expect(mobileIdx).toBeGreaterThan(-1);
    const mobileBlock = titleBarCss.slice(mobileIdx);

    // 44x44 tap target for titlebar sidebar toggles at <=640px / coarse
    expect(mobileBlock).toContain('[data-wb-resource-sidebar-toggle]');
    expect(mobileBlock).toContain('[data-wb-chat-sidebar-toggle]');
    // Title center offsets past traffic lights (140px) + 44px sidebar toggle + 4px gap = 188px
    expect(mobileBlock).toContain('left: 188px;');
  });

  it('suppresses the body drawer handle in 360px Essay/Translation workbench windows when titlebar "切换边栏" is mounted', async () => {
    let resizeCallback!: ResizeObserverCallback;
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);

    const slot = document.createElement('div');
    slot.setAttribute('data-wb-titlebar-slot', '');
    slot.dataset.windowId = 'win-essay-360';
    document.body.appendChild(slot);

    const { container } = render(
      <ResourceAppWorkspace
        type="essay"
        windowId="win-essay-360"
        initialResourceId="essay-1"
        isActive
        onTitleChange={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('resource-content')).toHaveTextContent('essay:essay-1');

    act(() => {
      resizeCallback(
        [{ contentRect: { width: 360 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });

    expect(screen.getByTestId('wb-essay-workspace')).toHaveAttribute('data-compact', 'true');
    // No floating/duplicate body drawer handle covering Essay content at 360px
    expect(container.querySelector('[data-wb-sys-drawer-handle]')).toBeNull();
    expect(container.querySelector('[data-wb-sys-compact-bar]')).toBeNull();
    expect(container.querySelector('.wb-sys-split')).toHaveAttribute('data-wb-sys-drawer-bar', 'false');

    // Single titlebar "切换边栏" button controls the compact drawer cleanly
    const toggle = screen.getByRole('button', { name: '切换边栏' });
    expect(slot.contains(toggle)).toBe(true);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('[data-wb-sys-drawer]')).toHaveAttribute('data-open', 'true');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('[data-wb-sys-drawer]')).toHaveAttribute('data-open', 'false');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
