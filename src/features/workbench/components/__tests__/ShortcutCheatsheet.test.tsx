/**
 * ShortcutCheatsheet 测试：对话框 aria 契约 / 分组标题渲染 / 键帽结构 /
 * 背景点击与关闭按钮关闭 / 退场动画期间保留 DOM 后卸载 /
 * shortcut-feedback 事件驱动的行高亮。
 */
import React from 'react';
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import {
  setWorkbenchShortcutPlatformOverride,
  useWorkbenchOverlay,
  WORKBENCH_SHORTCUT_FEEDBACK_EVENT,
} from '../../core/shortcuts';
import { ShortcutCheatsheet, CHEATSHEET_EXIT_MS } from '../ShortcutCheatsheet';

function resetOverlay() {
  useWorkbenchOverlay.setState({
    exposeOpen: false,
    switcherOpen: false,
    switcherIds: [],
    switcherIndex: 0,
    cheatsheetOpen: false,
    cheatsheetSticky: false,
  });
}

function openSheet() {
  act(() => {
    useWorkbenchOverlay.getState().openCheatsheet({ sticky: true });
  });
}

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

beforeEach(() => {
  resetOverlay();
});

afterEach(() => {
  vi.useRealTimers();
  setWorkbenchShortcutPlatformOverride(null);
});

describe('渲染与 aria', () => {
  it('未打开时不渲染', () => {
    render(<ShortcutCheatsheet />);
    expect(document.querySelector('.wb-cheat-root')).toBeNull();
  });

  it('打开后渲染 aria-modal 对话框与标题', () => {
    render(<ShortcutCheatsheet />);
    openSheet();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', '键盘快捷键');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('键盘快捷键');
  });

  it('渲染全部分组标题（顺序 = 平铺/移动/导航/管理/帮助）', () => {
    render(<ShortcutCheatsheet />);
    openSheet();

    const titles = Array.from(
      document.querySelectorAll('.wb-cheat-group-title'),
    ).map((el) => el.textContent);
    expect(titles).toEqual(['平铺与布局', '移动与贴边', '切换与导航', '窗口管理', '帮助']);
  });

  it('macOS 平台：键帽输出 ⌘ 符号（顺序 ⌃⌥⇧⌘）、底部提示为 ⌘⌥ 文案', () => {
    setWorkbenchShortcutPlatformOverride(true);
    render(<ShortcutCheatsheet />);
    openSheet();

    const capsOf = (id: string) =>
      Array.from(
        document.querySelectorAll(`[data-wb-cheat-shortcut="${id}"] kbd.wb-cheat-key`),
      ).map((el) => el.textContent);
    expect(capsOf('close-window')).toEqual(['⌘', 'W']);
    expect(capsOf('tile-left')).toEqual(['⌥', '⌘', '←']);
    expect(capsOf('move-left')).toEqual(['⌥', '⇧', '⌘', '←']);
    expect(document.querySelector('.wb-cheat-footer')?.textContent).toContain('⌘⌥');
  });

  it('非 macOS 平台：键帽保持 Ctrl/Alt 文本、提示为 Ctrl+Alt 文案', () => {
    setWorkbenchShortcutPlatformOverride(false);
    render(<ShortcutCheatsheet />);
    openSheet();

    const caps = Array.from(
      document.querySelectorAll('[data-wb-cheat-shortcut="close-window"] kbd.wb-cheat-key'),
    ).map((el) => el.textContent);
    expect(caps).toEqual(['Ctrl', 'W']);
    expect(document.querySelector('.wb-cheat-footer')?.textContent).toContain('Ctrl+Alt');
  });

  it('每行渲染描述 + kbd 键帽（多段键位以分隔符连接）', () => {
    render(<ShortcutCheatsheet />);
    openSheet();

    const rows = document.querySelectorAll('.wb-cheat-row');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.querySelector('.wb-cheat-desc')?.textContent).toBeTruthy();
      const caps = row.querySelectorAll('kbd.wb-cheat-key');
      expect(caps.length).toBeGreaterThan(0);
      // n 段键帽应有 n-1 个分隔符
      expect(row.querySelectorAll('.wb-cheat-key-sep')).toHaveLength(caps.length - 1);
    }
  });
});

describe('关闭路径', () => {
  it('点击背景关闭', () => {
    render(<ShortcutCheatsheet />);
    openSheet();

    fireEvent.click(document.querySelector('[data-wb-cheat-backdrop]')!);
    expect(useWorkbenchOverlay.getState().cheatsheetOpen).toBe(false);
  });

  it('点击右上角关闭按钮关闭', () => {
    render(<ShortcutCheatsheet />);
    openSheet();

    fireEvent.click(screen.getByLabelText('关闭'));
    expect(useWorkbenchOverlay.getState().cheatsheetOpen).toBe(false);
  });

  it('关闭后保留 DOM 播放退场动画，超时后卸载', () => {
    vi.useFakeTimers();
    render(<ShortcutCheatsheet />);
    openSheet();

    act(() => {
      useWorkbenchOverlay.getState().closeCheatsheet();
    });
    // 退场期间仍挂载（data-wb-cheat-open=false 驱动 CSS 退场）
    const root = document.querySelector('.wb-cheat-root');
    expect(root).not.toBeNull();
    expect(root).toHaveAttribute('data-wb-cheat-open', 'false');

    act(() => {
      vi.advanceTimersByTime(CHEATSHEET_EXIT_MS + 50);
    });
    expect(document.querySelector('.wb-cheat-root')).toBeNull();
  });

  it('退场中重新打开立即恢复（清理卸载定时器）', () => {
    vi.useFakeTimers();
    render(<ShortcutCheatsheet />);
    openSheet();

    act(() => {
      useWorkbenchOverlay.getState().closeCheatsheet();
    });
    openSheet();

    act(() => {
      vi.advanceTimersByTime(CHEATSHEET_EXIT_MS + 100);
    });
    const root = document.querySelector('.wb-cheat-root');
    expect(root).not.toBeNull();
    expect(root).toHaveAttribute('data-wb-cheat-open', 'true');
  });
});

describe('快捷键触发反馈高亮', () => {
  it('收到 feedback 事件时对应行加 flash 类，超时后移除', () => {
    vi.useFakeTimers();
    render(<ShortcutCheatsheet />);
    openSheet();

    const firstRow = document.querySelector<HTMLElement>('[data-wb-cheat-shortcut]')!;
    const shortcutId = firstRow.getAttribute('data-wb-cheat-shortcut')!;
    act(() => {
      window.dispatchEvent(
        new CustomEvent(WORKBENCH_SHORTCUT_FEEDBACK_EVENT, {
          detail: { shortcutId },
        }),
      );
    });
    expect(firstRow.classList.contains('wb-cheat-row-flash')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(firstRow.classList.contains('wb-cheat-row-flash')).toBe(false);
  });
});
