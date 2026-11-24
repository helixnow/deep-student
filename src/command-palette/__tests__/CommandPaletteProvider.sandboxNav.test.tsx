import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  isWorkbenchHostEnabled: vi.fn(() => true),
  launchWorkbenchApp: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/shared/workbenchHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/workbenchHost')>()),
  isWorkbenchHostEnabled: mocks.isWorkbenchHostEnabled,
  launchWorkbenchApp: mocks.launchWorkbenchApp,
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mocks.toastError,
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'zh-CN' } }),
}));

import {
  CommandPaletteProvider,
  commandRegistry,
  useCommandPalette,
} from '../index';
import { getNavigationCommands } from '../modules/navigation.commands';

function TriggerButton() {
  const { executeCommand } = useCommandPalette();
  return (
    <button
      type="button"
      data-testid="exec-sandbox-cmd"
      onClick={() => void executeCommand('nav.goto.sandbox-workbench')}
    >
      Go Sandbox
    </button>
  );
}

describe('CommandPaletteProvider nav.goto.sandbox-workbench (S3-08)', () => {
  let unregister: (() => void) | null = null;

  beforeEach(() => {
    cleanup();
    mocks.isWorkbenchHostEnabled.mockReturnValue(true);
    mocks.launchWorkbenchApp.mockReset();
    mocks.toastError.mockReset();
    unregister = commandRegistry.registerAll(getNavigationCommands());
  });

  afterEach(() => {
    unregister?.();
    unregister = null;
  });

  it('launches sandbox workbench app when executing nav.goto.sandbox-workbench in workbench mode', async () => {
    const navigate = vi.fn();

    render(
      <CommandPaletteProvider
        currentView="chat-v2"
        workbenchActive={true}
        navigate={navigate}
        toggleTheme={() => undefined}
        isDarkMode={false}
        switchLanguage={() => undefined}
      >
        <TriggerButton />
      </CommandPaletteProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('exec-sandbox-cmd'));
    });

    expect(mocks.launchWorkbenchApp).toHaveBeenCalledWith({
      typeId: 'sandbox',
      reason: 'command',
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('falls back to legacy navigate callback when workbench mode is inactive', async () => {
    const navigate = vi.fn();

    render(
      <CommandPaletteProvider
        currentView="chat-v2"
        workbenchActive={false}
        navigate={navigate}
        toggleTheme={() => undefined}
        isDarkMode={false}
        switchLanguage={() => undefined}
      >
        <TriggerButton />
      </CommandPaletteProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('exec-sandbox-cmd'));
    });

    expect(mocks.launchWorkbenchApp).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('sandbox-workbench', undefined);
  });
});
