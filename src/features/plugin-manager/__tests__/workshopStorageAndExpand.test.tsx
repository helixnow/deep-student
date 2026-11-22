import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginStoragePrefix } from '@/ui-kernel/services/storage';
import { PluginDataSection } from '../PluginDataSection';
import { PluginManagerPanel } from '../PluginManagerPanel';
import { PluginManagerController } from '../controller';
import { registerPluginManagerWorkshop, type PluginManagerWorkshop } from '../workshop';
import { FakePluginManagerAdapter } from './fixtures';

vi.mock('react-i18next', async () => (await import('./i18nMock')).i18nMock());

describe('PluginDataSection Host storage integration (GAP-5)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('merges Host storedData with localStorage entries and clears both on confirmation', async () => {
    window.localStorage.setItem(`${pluginStoragePrefix('workshop.alpha')}localKey`, 'abc');

    let hostStored = { keys: ['files/data.json', 'settings:streak'], bytes: 2048 };
    const clearStoredData = vi.fn(async () => {
      hostStored = { keys: [], bytes: 0 };
      return 2;
    });
    const storedData = vi.fn(async () => hostStored);

    const revoke = registerPluginManagerWorkshop({
      onCreate: vi.fn(),
      onModify: vi.fn(),
      storedData,
      clearStoredData,
      creations: null,
    });

    try {
      const user = userEvent.setup();
      render(<PluginDataSection pluginId="workshop.alpha" name="Alpha Tool" />);

      await waitFor(() => {
        expect(screen.getByTestId('plugin-detail-data-keys')).toHaveTextContent(
          'files/data.json, localKey, settings:streak',
        );
      });

      await user.click(screen.getByTestId('plugin-detail-data-clear'));
      await user.click(screen.getByTestId('plugin-detail-data-clear-confirm'));

      await waitFor(() => {
        expect(clearStoredData).toHaveBeenCalledWith('workshop.alpha');
        expect(screen.queryByTestId('plugin-detail-data-keys')).toBeNull();
      });
      expect(window.localStorage.getItem(`${pluginStoragePrefix('workshop.alpha')}localKey`)).toBeNull();
    } finally {
      revoke();
    }
  });
});

describe('PluginManagerPanel auto-expand and auto-collapse (GAP-5)', () => {
  it('auto-opens during active/pending work, auto-closes when idle, and respects manual toggle', async () => {
    let pendingList: { pluginId: string; name: string; phase: string }[] = [];
    let isActive = true;

    const workshop: PluginManagerWorkshop = {
      onCreate: vi.fn(),
      onModify: vi.fn(),
      pending: vi.fn(async () => pendingList),
      hasActive: vi.fn(async () => isActive),
      creations: <div data-testid="creations-body">Creations Content</div>,
    };

    const revoke = registerPluginManagerWorkshop(workshop);
    try {
      const adapter = new FakePluginManagerAdapter([]);
      const controller = new PluginManagerController(adapter);
      const view = render(<PluginManagerPanel controller={controller} />);

      const toggle = await screen.findByTestId('plugin-creations-toggle');
      await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
      expect(screen.getByTestId('creations-body')).toBeInTheDocument();

      // Re-mount when idle: auto-closes
      isActive = false;
      pendingList = [];
      view.unmount();

      const viewIdle = render(<PluginManagerPanel controller={controller} />);
      const toggleIdle = await screen.findByTestId('plugin-creations-toggle');
      await waitFor(() => expect(toggleIdle).toHaveAttribute('aria-expanded', 'false'));

      // Manual toggle overrides auto state even across polling / mineSignature updates
      const user = userEvent.setup();
      await user.click(toggleIdle);
      expect(toggleIdle).toHaveAttribute('aria-expanded', 'true');
      viewIdle.unmount();
    } finally {
      revoke();
    }
  });
});
