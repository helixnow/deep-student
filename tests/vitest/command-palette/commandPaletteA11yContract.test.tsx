/**
 * 命令面板键盘 / 读屏契约：
 * - 搜索框是 combobox，通过 aria-controls / aria-activedescendant 关联结果 listbox
 * - 结果项是 option 且有稳定 id，方向键改变 aria-activedescendant
 * - Tab 不再被一刀切吞掉：可以走到面板内的收藏 / 模式 / 关闭按钮，并在两端回绕
 * - 移动端（390 宽）：关闭入口可聚焦，焦点仍锁在面板内
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/command-palette/hooks/useResourceSearch', () => ({
  useResourceSearch: () => ({ fileResults: [], sessionResults: [] }),
  openFileFromPalette: vi.fn(),
  openSessionFromPalette: vi.fn(),
}));

import { CommandPalette } from '@/command-palette/CommandPalette';
import { CommandPaletteProvider, useCommandPalette } from '@/command-palette/CommandPaletteProvider';
import { commandRegistry } from '@/command-palette/registry/commandRegistry';
import { commandFavorites } from '@/command-palette/registry/commandFavorites';
import type { Command } from '@/command-palette/registry/types';

const DESKTOP_WIDTH = 1280;
const MOBILE_WIDTH = 390;

/** 让 matchMedia 按给定视口宽度回答 (min-width: Npx) 查询 */
function setViewportWidth(width: number) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      const matches = minWidth ? width >= Number(minWidth[1]) : false;
      return {
        matches,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      };
    },
  });
}

const TEST_COMMANDS: Command[] = [
  {
    id: 'test.alpha',
    name: 'Alpha command',
    category: 'navigation',
    execute: () => undefined,
  },
  {
    id: 'test.beta',
    name: 'Beta command',
    category: 'navigation',
    execute: () => undefined,
  },
];

function OpenPaletteButton() {
  const { open } = useCommandPalette();
  return (
    <button type="button" onClick={open}>
      open-palette
    </button>
  );
}

function renderPalette() {
  return render(
    <CommandPaletteProvider
      currentView="chat-v2"
      navigate={() => undefined}
      toggleTheme={() => undefined}
      isDarkMode={false}
      switchLanguage={() => undefined}
    >
      <OpenPaletteButton />
      <CommandPalette />
    </CommandPaletteProvider>,
  );
}

async function openPalette() {
  renderPalette();
  fireEvent.click(screen.getByText('open-palette'));
  return screen.findByRole('combobox');
}

function paletteFocusables(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '.command-palette-container button, .command-palette-container input',
    ),
  );
}

beforeEach(() => {
  setViewportWidth(DESKTOP_WIDTH);
  commandRegistry.clear();
  commandRegistry.registerAll(TEST_COMMANDS);
  for (const id of commandFavorites.getAll()) {
    commandFavorites.toggle(id);
  }
});

afterEach(() => {
  commandRegistry.clear();
});

describe('CommandPalette 键盘 / 读屏契约', () => {
  it('搜索框是 combobox 且用 aria-controls 指向结果 listbox', async () => {
    const input = await openPalette();

    const listbox = screen.getByRole('listbox');
    expect(listbox.id).toBeTruthy();
    expect(input).toHaveAttribute('aria-controls', listbox.id);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
  });

  it('aria-activedescendant 指向当前高亮的 option，方向键会跟着走', async () => {
    const input = await openPalette();

    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThanOrEqual(2);
    for (const option of options) {
      expect(option.id).toBeTruthy();
    }

    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(input).toHaveAttribute('aria-activedescendant', options[1].id);
    });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('结果分组是带可访问名的 group，不是裸 div', async () => {
    await openPalette();

    const groups = screen.getAllByRole('group');
    expect(groups.length).toBeGreaterThanOrEqual(1);
    const labelId = groups[0].getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)).not.toBeNull();
  });

  it('Tab 不再被一刀切吞掉：可以从搜索框走到面板内的按钮', async () => {
    const user = userEvent.setup();
    const input = await openPalette();

    await waitFor(() => expect(input).toHaveFocus());

    // 旧实现在这里对 Tab 无条件 preventDefault，焦点永远停在输入框
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);

    await user.tab();
    expect(document.activeElement).not.toBe(input);
    expect(document.activeElement?.tagName).toBe('BUTTON');
  });

  it('面板内的图标按钮（收藏 / 模式 / 关闭）都有可访问名', async () => {
    await openPalette();

    expect(screen.getByRole('button', { name: /command_palette:mode_recent/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /command_palette:mode_favorites/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /关闭|common:close/ })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /command_palette:favorite — Alpha command/ }),
    ).toBeInTheDocument();
  });

  it('Tab 焦点环闭合：最后一个控件按 Tab 回到第一个，Shift+Tab 反向回绕', async () => {
    const input = await openPalette();

    const focusables = paletteFocusables();
    expect(focusables.length).toBeGreaterThan(1);

    const last = focusables[focusables.length - 1];
    last.focus();
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(focusables[0]);

    input.focus();
    expect(fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it('焦点在面板内按钮上时，Enter 归按钮，不再被「执行高亮命令」抢走', async () => {
    await openPalette();

    const favoriteButton = screen.getByRole('button', {
      name: /command_palette:favorite — Alpha command/,
    });
    favoriteButton.focus();

    // 未被 preventDefault → 浏览器把 Enter 交给按钮的默认激活行为
    expect(fireEvent.keyDown(favoriteButton, { key: 'Enter' })).toBe(true);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('Escape 关闭面板，焦点回到打开面板的元素', async () => {
    renderPalette();
    const trigger = screen.getByText('open-palette');
    trigger.focus();
    fireEvent.click(trigger);
    const input = await screen.findByRole('combobox');

    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });
    expect(document.activeElement).toBe(trigger);
  });
});

describe('CommandPalette 移动端（390 宽）焦点契约', () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  it('全屏形态下关闭入口可聚焦，且焦点仍锁在面板内', async () => {
    const input = await openPalette();

    const closeButton = screen.getByRole('button', { name: /返回|common:back/ });
    closeButton.focus();
    expect(document.activeElement).toBe(closeButton);

    // 关闭入口是面板内第一个可聚焦控件：Shift+Tab 应回绕到面板末尾，而不是逃到背景页
    const focusables = paletteFocusables();
    expect(focusables[0]).toBe(closeButton);
    expect(fireEvent.keyDown(closeButton, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);

    // 输入框依旧是 combobox
    expect(input).toHaveAttribute('role', 'combobox');
  });

  it('点击关闭入口能关掉面板', async () => {
    await openPalette();

    fireEvent.click(screen.getByRole('button', { name: /返回|common:back/ }));

    await waitFor(() => {
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });
  });
});
