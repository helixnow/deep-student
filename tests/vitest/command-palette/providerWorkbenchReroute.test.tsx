/**
 * CommandPaletteProvider — workbenchActive 改道测试
 *
 * OS 模式下独立命令面板退役：open/toggle（⌘K、顶栏入口、命令内
 * openCommandPalette）统一改道到全部应用面板（应用 + 命令统一搜索）；
 * legacy 壳（无 workbenchActive）行为不变。
 */
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandPaletteProvider, useCommandPalette } from '@/command-palette';
import { closeAppsPanel, isAppsPanelOpen } from '@/features/workbench/components/appsPanelStore';

const Probe: React.FC = () => {
  const { isOpen, open, toggle } = useCommandPalette();
  return (
    <div>
      <output data-testid="cp-open">{String(isOpen)}</output>
      <button type="button" data-testid="open" onClick={open} />
      <button type="button" data-testid="toggle" onClick={toggle} />
    </div>
  );
};

function renderProvider(workbenchActive: boolean) {
  return render(
    <CommandPaletteProvider
      workbenchActive={workbenchActive}
      currentView="chat-v2"
      navigate={() => undefined}
      toggleTheme={() => undefined}
      isDarkMode={false}
      switchLanguage={() => undefined}
    >
      <Probe />
    </CommandPaletteProvider>,
  );
}

describe('CommandPaletteProvider workbench 改道', () => {
  beforeEach(() => {
    closeAppsPanel();
  });

  it('workbenchActive：open/toggle 改道全部应用面板，独立面板不打开', () => {
    renderProvider(true);

    fireEvent.click(screen.getByTestId('open'));
    expect(screen.getByTestId('cp-open')).toHaveTextContent('false');
    expect(isAppsPanelOpen()).toBe(true);

    fireEvent.click(screen.getByTestId('toggle'));
    expect(isAppsPanelOpen()).toBe(false);
    expect(screen.getByTestId('cp-open')).toHaveTextContent('false');
  });

  it('workbenchActive：⌘K 同样改道全部应用面板', () => {
    renderProvider(true);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(isAppsPanelOpen()).toBe(true);
    expect(screen.getByTestId('cp-open')).toHaveTextContent('false');
  });

  it('legacy（无 workbenchActive）：仍打开独立命令面板', () => {
    renderProvider(false);
    fireEvent.click(screen.getByTestId('open'));
    expect(screen.getByTestId('cp-open')).toHaveTextContent('true');
    expect(isAppsPanelOpen()).toBe(false);
  });
});
