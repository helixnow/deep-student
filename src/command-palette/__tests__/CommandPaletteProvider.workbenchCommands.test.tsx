import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandPaletteProvider, useCommandPalette } from '../CommandPaletteProvider';
import { commandRegistry } from '../registry/commandRegistry';
import { notifyWorkbenchHostChanged, setWorkbenchHostBridge } from '@/shared/workbenchHost';
import { useWorkbenchShortcuts } from '@/features/workbench/hooks/useWorkbenchShortcuts';
import {
  closeAppsPanel,
  isAppsPanelOpen,
  openAppsPanel,
  toggleAppsPanel as toggleAppsPanelStore,
} from '@/features/workbench/components/appsPanelStore';

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

const WorkbenchShortcutsHarness: React.FC = () => {
  useWorkbenchShortcuts({ enabled: true });
  return (
    <div data-wb-window data-focused="true" onKeyDown={(e) => e.stopPropagation()}>
      <input data-testid="settings-window-input" aria-label="Settings Foreground Input" />
    </div>
  );
};

describe('CommandPaletteProvider workbench commands & Settings Ctrl+K capture (S4-12)', () => {
  beforeEach(() => {
    setWorkbenchHostBridge(null);
    closeAppsPanel();
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

  it('opens and toggles AppsPanel once (no double-toggle) on Ctrl+K / Meta+K when Settings window becomes focused alongside useWorkbenchShortcuts', () => {
    let focusedApp = 'chat';
    setWorkbenchHostBridge({
      isEnabled: () => true,
      focusedAppTypeId: () => focusedApp,
      workspaceActiveResourceType: () => null,
      openAppsPanel,
      toggleAppsPanel: toggleAppsPanelStore,
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
        <WorkbenchShortcutsHarness />
      </CommandPaletteProvider>,
    );

    // Simulate bringing Settings window to foreground
    focusedApp = 'settings';
    notifyWorkbenchHostChanged();

    const settingsInput = screen.getByTestId('settings-window-input');
    settingsInput.focus();

    fireEvent.keyDown(settingsInput, { key: 'k', code: 'KeyK', ctrlKey: true });
    expect(isAppsPanelOpen()).toBe(true);

    fireEvent.keyDown(settingsInput, { key: 'k', code: 'KeyK', metaKey: true });
    expect(isAppsPanelOpen()).toBe(false);
  });

  it('still opens AppsPanel on Ctrl+K inside Settings even before workbenchHostBridge is installed', () => {
    setWorkbenchHostBridge(null);

    render(
      <CommandPaletteProvider
        currentView="chat-v2"
        workbenchActive
        navigate={vi.fn()}
        toggleTheme={vi.fn()}
        isDarkMode={false}
        switchLanguage={vi.fn()}
      >
        <WorkbenchShortcutsHarness />
      </CommandPaletteProvider>,
    );

    const settingsInput = screen.getByTestId('settings-window-input');
    settingsInput.focus();
    fireEvent.keyDown(settingsInput, { key: 'k', code: 'KeyK', ctrlKey: true });
    expect(isAppsPanelOpen()).toBe(true);
  });
});
