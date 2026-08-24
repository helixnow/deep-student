import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts === 'object' && 'name' in opts) {
        return `${key}:${String(opts.name)}`;
      }
      return key;
    },
  }),
}));

import { ActionMenu, PresetServerSelector } from '../McpToolsSection';
import { resolvePopoverPosition } from '@/components/ui/shad/Popover';
import { Z_INDEX } from '@/config/zIndex';

const originalMatchMedia = window.matchMedia;
const originalInnerWidth = window.innerWidth;

/**
 * #46 窄屏（安卓平板/横屏，≥768px 但仍窄）视口模拟：
 * matchMedia 按真实 min-width 解析，innerWidth 同步为目标宽度。
 */
function mockViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const minWidth = /\(min-width:\s*(\d+(?:\.\d+)?)px\)/.exec(query);
      return {
        matches: minWidth ? width >= parseFloat(minWidth[1]) : false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

function restoreViewport() {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: originalInnerWidth,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
}

const actionMenuProps = {
  onReconnect: vi.fn(),
  onRefresh: vi.fn(),
  onHealthCheck: vi.fn(),
  onClearCache: vi.fn(),
  onOpenPolicy: vi.fn(),
};

describe('McpToolsSection narrow-viewport overlays (#46)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreViewport();
  });

  describe('quick actions menu on narrow ≥768px viewport (Android tablet/landscape)', () => {
    it('portals to document.body with fixed positioning and popover z-index', async () => {
      mockViewport(820);
      const { container } = render(<ActionMenu {...actionMenuProps} />);

      fireEvent.click(
        screen.getByRole('button', { name: /quick_actions/ }),
      );

      const menu = await screen.findByTestId('mcp-quick-actions-menu');
      // Portal 到 body：不再是设置内容滚动容器的后代，不会被 overflow 裁切，
      // 也不会被侧栏的局部 stacking context 压住
      expect(container.contains(menu)).toBe(false);
      expect(document.body.contains(menu)).toBe(true);
      expect(menu.className).toContain('fixed');
      expect(Number(menu.style.zIndex)).toBe(Z_INDEX.popover);
      // 视口宽度约束：窄屏下不允许超出屏幕
      expect(menu.className).toContain('max-w-[calc(100vw-1rem)]');
    });

    it('stays horizontally inside the viewport after collision clamping', async () => {
      mockViewport(820);
      render(<ActionMenu {...actionMenuProps} />);

      fireEvent.click(
        screen.getByRole('button', { name: /quick_actions/ }),
      );

      const menu = await screen.findByTestId('mcp-quick-actions-menu');
      await waitFor(() => {
        const left = parseFloat(menu.style.left);
        expect(Number.isNaN(left)).toBe(false);
        expect(left).toBeGreaterThanOrEqual(0);
        expect(left + menu.offsetWidth).toBeLessThanOrEqual(window.innerWidth);
      });
    });

    it('closes after an action is chosen and invokes the handler', async () => {
      mockViewport(820);
      render(<ActionMenu {...actionMenuProps} />);

      fireEvent.click(
        screen.getByRole('button', { name: /quick_actions/ }),
      );
      fireEvent.click(
        await screen.findByRole('button', { name: /mcp\.reconnect/ }),
      );

      expect(actionMenuProps.onReconnect).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(screen.queryByTestId('mcp-quick-actions-menu')).not.toBeInTheDocument();
      });
    });
  });

  describe('preset selector on narrow ≥768px viewport', () => {
    it('portals to document.body with fixed positioning, popover z-index and viewport max-width', async () => {
      mockViewport(820);
      const { container } = render(
        <PresetServerSelector existingServerIds={[]} onAddPreset={() => undefined} />,
      );

      const addBtn = screen.getByTestId('mcp-preset-add-btn');
      expect(addBtn).toHaveAttribute('aria-haspopup', 'dialog');
      fireEvent.click(addBtn);

      const selector = await screen.findByTestId('mcp-preset-selector');
      expect(container.contains(selector)).toBe(false);
      expect(document.body.contains(selector)).toBe(true);
      expect(selector.className).toContain('fixed');
      expect(Number(selector.style.zIndex)).toBe(Z_INDEX.popover);
      expect(selector.className).toContain('max-w-[calc(100vw-1.5rem)]');
      // 旧实现的全屏 fixed 遮罩已移除（外点击由 Popover 文档级监听处理）
      expect(screen.queryByTestId('mcp-preset-selector-backdrop')).not.toBeInTheDocument();
    });

    it('closes on Escape and returns focus to the trigger', async () => {
      mockViewport(820);
      render(
        <PresetServerSelector existingServerIds={[]} onAddPreset={() => undefined} />,
      );

      const addBtn = screen.getByTestId('mcp-preset-add-btn');
      fireEvent.click(addBtn);
      await screen.findByTestId('mcp-preset-selector');

      fireEvent.keyDown(window, { key: 'Escape', bubbles: true });
      await waitFor(() => {
        expect(screen.queryByTestId('mcp-preset-selector')).not.toBeInTheDocument();
      });
      await waitFor(() => {
        expect(addBtn).toHaveFocus();
      });
    });

    it('closes when clicking outside the popover', async () => {
      mockViewport(820);
      render(
        <PresetServerSelector existingServerIds={[]} onAddPreset={() => undefined} />,
      );

      fireEvent.click(screen.getByTestId('mcp-preset-add-btn'));
      await screen.findByTestId('mcp-preset-selector');

      fireEvent.mouseDown(document.body);
      await waitFor(() => {
        expect(screen.queryByTestId('mcp-preset-selector')).not.toBeInTheDocument();
      });
    });
  });

  describe('small screen (<768px) keeps P0-3 inline expansion', () => {
    it('quick actions expand inline without portal or fixed overlay', () => {
      mockViewport(360);
      const { container } = render(<ActionMenu {...actionMenuProps} />);

      fireEvent.click(
        screen.getByRole('button', { name: /quick_actions/ }),
      );

      // 内联展开：菜单保持在组件子树内，无 body portal、无 fixed 遮罩
      expect(screen.queryByTestId('mcp-quick-actions-menu')).not.toBeInTheDocument();
      const reconnect = screen.getByRole('button', { name: /mcp\.reconnect/ });
      expect(container.contains(reconnect)).toBe(true);
      expect(container.querySelector('.fixed')).toBeNull();
    });

    it('preset selector expands inline within the component subtree', async () => {
      mockViewport(360);
      const { container } = render(
        <PresetServerSelector existingServerIds={[]} onAddPreset={() => undefined} />,
      );

      fireEvent.click(screen.getByTestId('mcp-preset-add-btn'));
      const selector = await screen.findByTestId('mcp-preset-selector');
      expect(container.contains(selector)).toBe(true);
      expect(selector).not.toHaveAttribute('aria-modal');
    });
  });

  describe('resolvePopoverPosition narrow-viewport clamping contract', () => {
    it('clamps a right-anchored 380px panel into a 820px viewport', () => {
      // 触发器靠内容区左侧（窄屏 flex-wrap 后按钮可能落在左边），
      // align=end 原生锚点会向左溢出为负值，必须钳回视口内
      const position = resolvePopoverPosition({
        triggerRect: { left: 20, right: 140, top: 200, bottom: 232, width: 120 },
        contentWidth: 380,
        contentHeight: 400,
        viewportWidth: 820,
        viewportHeight: 1180,
        align: 'end',
        side: 'bottom',
        sideOffset: 4,
        collisionPadding: 8,
      });
      expect(position.left).toBeGreaterThanOrEqual(8);
      expect(position.left + 380).toBeLessThanOrEqual(820 - 8);
    });

    it('keeps the panel on-screen when the trigger hugs the right edge', () => {
      const position = resolvePopoverPosition({
        triggerRect: { left: 700, right: 812, top: 200, bottom: 232, width: 112 },
        contentWidth: 380,
        contentHeight: 400,
        viewportWidth: 820,
        viewportHeight: 1180,
        align: 'end',
        side: 'bottom',
        sideOffset: 4,
        collisionPadding: 8,
      });
      expect(position.left).toBeGreaterThanOrEqual(8);
      expect(position.left + 380).toBeLessThanOrEqual(820 - 8);
    });
  });
});
