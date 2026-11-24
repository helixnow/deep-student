import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandPaletteProvider, useCommandPalette } from '../CommandPaletteProvider';
import { commandRegistry } from '../registry/commandRegistry';
import { setWorkbenchHostBridge } from '@/shared/workbenchHost';

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

const Probe: React.FC<{ onCommands?: (names: string[]) => void }> = ({ onCommands }) => {
  const { searchCommands, executeCommand } = useCommandPalette();
  return (
    <div>
      <button
        type="button"
        data-testid="search-tile"
        onClick={() => {
          const results = searchCommands('平铺');
          onCommands?.(results.map((c) => `${c.id}:${c.name}`));
        }}
      >
        Search
      </button>
      <button
        type="button"
        data-testid="exec-tile-left"
        onClick={() => void executeCommand('workbench.tile-left')}
      >
        Tile Left
      </button>
      <div onKeyDown={(e) => e.stopPropagation()}>
        <input data-testid="settings-stopped-input" aria-label="Settings Search" />
      </div>
    </div>
  );
};

describe('CommandPaletteProvider workbench commands & Settings Ctrl+K capture (S4-12)', () => {
  beforeEach(() => {
    setWorkbenchHostBridge(null);
  });

  it('triggers toggleWorkbenchAppsPanel on Ctrl+K even when Settings child calls stopPropagation inside an input', () => {
    const toggleAppsPanel = vi.fn();
    setWorkbenchHostBridge({
      isEnabled: () => true,
      focusedAppTypeId: () => 'settings',
      workspaceActiveResourceType: () => null,
      openAppsPanel: vi.fn(),
      toggleAppsPanel,
      activate: async () => false,
      launch: () => null,
      hasApp: () => false,
      isPdfPageActivationType: () => false,
      openPdfPage: async () => ({ delivered: false }),
      consumeHandoff: () => null,
      installLegacyNavigationFallback: () => undefined,
      hasDirtyWindows: () => false,
      runDeactivationTransaction: async () => undefined,
      flushSnapshot: async () => undefined,
    });

    render(
      <CommandPaletteProvider
        currentView="chat-v2"
        workbenchActive
        navigate={vi.fn()}
        toggleTheme={vi.fn()}
        isDarkMode={false}
        switchLanguage={vi.fn()}
      >
        <Probe />
      </CommandPaletteProvider>,
    );

    const input = screen.getByTestId('settings-stopped-input');
    input.focus();
    fireEvent.keyDown(input, { key: 'K', code: 'KeyK', ctrlKey: true });
    expect(toggleAppsPanel).toHaveBeenCalledTimes(1);
  });

  it('registers tileLeft, tileRight, restoreFloating, and expose while workbenchActive and dispatches window events', () => {
    const observed: string[] = [];
    const dispatchedActions: string[] = [];
    const onCmd = (ev: Event) => {
      dispatchedActions.push((ev as CustomEvent<{ action?: string }>).detail?.action ?? '');
    };
    window.addEventListener('workbench:window-command', onCmd);

    try {
      const { unmount } = render(
        <CommandPaletteProvider
          currentView="chat-v2"
          workbenchActive
          navigate={vi.fn()}
          toggleTheme={vi.fn()}
          isDarkMode={false}
          switchLanguage={vi.fn()}
        >
          <Probe onCommands={(list) => observed.push(...list)} />
        </CommandPaletteProvider>,
      );

      fireEvent.click(screen.getByTestId('search-tile'));
      expect(observed.some((entry) => entry.startsWith('workbench.tile-left:'))).toBe(true);
      expect(observed.some((entry) => entry.startsWith('workbench.tile-right:'))).toBe(true);
      expect(observed.some((entry) => entry.startsWith('workbench.restore-floating:'))).toBe(true);
      expect(observed.some((entry) => entry.startsWith('workbench.expose:'))).toBe(true);

      fireEvent.click(screen.getByTestId('exec-tile-left'));
      expect(dispatchedActions).toContain('tileLeft');

      unmount();
      expect(commandRegistry.getAll().some((cmd) => cmd.id === 'workbench.tile-left')).toBe(false);
    } finally {
      window.removeEventListener('workbench:window-command', onCmd);
    }
  });
});
