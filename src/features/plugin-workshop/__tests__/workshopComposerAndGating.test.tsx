import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { provideAppUiKernel } from '@/ui-kernel/app-kernel';
import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import { startCommunityUiPlugins, type CommunityUiBridge, type UiHostManifest } from '@/ui-kernel/community';
import { UiHostStatusService } from '@/ui-kernel/services/host-status';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { registerPluginManagerWorkshop, type PluginManagerWorkshop } from '@/features/plugin-manager/workshop';
import type { AppWindowProps } from '@/features/workbench/core/types';
import { hostGatedApp } from '@/features/workbench/apps/system/hostGatedApp';
import PluginWorkshopAppWindow from '@/features/workbench/apps/system/PluginWorkshopAppWindow';
import { WorkshopComposer } from '../WorkshopComposer';

vi.mock('react-i18next', async () => (await import('../../plugin-manager/__tests__/i18nMock')).i18nMock());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeAll(async () => {
  await import('@/components/system-status/HostUnavailablePanel');
});

afterEach(() => {
  provideAppUiKernel(undefined);
  useSystemStatusStore.getState().setComponentHealth([]);
  vi.restoreAllMocks();
});

describe('G03b: UiHostStatusService.setSafeMode & URL safe-mode boot', () => {
  it('sets safeMode without marking host inventory as known or official plugins as missing', () => {
    const service = new UiHostStatusService();
    const listener = vi.fn();
    service.subscribe(listener);

    expect(service.known).toBe(false);
    expect(service.safeMode).toBe(false);
    expect(service.state('dstu.plugin-workshop')).toBe('unknown');

    service.setSafeMode(true);
    expect(service.safeMode).toBe(true);
    expect(service.known).toBe(false);
    expect(service.state('dstu.plugin-workshop')).toBe('unknown');
    expect(service.availability(['dstu.plugin-workshop'])).toBe('available');
    expect(listener).toHaveBeenCalledTimes(1);

    // Idempotent call emits nothing.
    service.setSafeMode(true);
    expect(listener).toHaveBeenCalledTimes(1);

    // Real v2 manifest later populates installed plugins cleanly.
    service.update({ plugins: [{ id: 'dstu.plugin-workshop' }], degraded: [], safeMode: true });
    expect(service.known).toBe(true);
    expect(service.safeMode).toBe(true);
    expect(service.state('dstu.plugin-workshop')).toBe('online');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps optimistic host-paired official plugins (e.g. dstu.plugin-workshop) installed under ?safeMode=1 before v2 manifest arrives', async () => {
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...originalLocation, search: '?safeMode=1', href: 'http://127.0.0.1:1422/?safeMode=1' },
    });

    const kernel = new UiKernel();
    const onDispose = vi.fn();
    const workshopUiPlugin = defineUiPlugin({
      meta: { id: 'dstu.plugin-workshop', version: '1.0.0', host: true },
      apply(ctx) {
        ctx.effect(() => onDispose);
      },
    });
    await kernel.install(workshopUiPlugin, { origin: 'builtin' });
    expect(kernel.list()).toEqual(['dstu.plugin-workshop']);

    const manifestReply = deferred<UiHostManifest>();
    const loadCommunity = vi.fn();
    const bridge: CommunityUiBridge = {
      invoke: vi.fn(async () => []),
      listen: vi.fn(async () => () => {}),
      manifest: vi.fn(() => manifestReply.promise),
      listenManifest: vi.fn(async () => () => {}),
      status: vi.fn(async () => []),
      listenStatus: vi.fn(async () => () => {}),
    };

    const stop = await startCommunityUiPlugins(kernel, bridge, loadCommunity);
    try {
      await kernel.settled();
      // Safe mode is flagged immediately, yet dstu.plugin-workshop was NOT unloaded before v2 manifest arrived.
      expect(kernel.hostStatus.safeMode).toBe(true);
      expect(kernel.hostStatus.known).toBe(false);
      expect(kernel.hostStatus.state('dstu.plugin-workshop')).toBe('unknown');
      expect(kernel.list()).toEqual(['dstu.plugin-workshop']);
      expect(onDispose).not.toHaveBeenCalled();

      // When real v2 manifest arrives in safe mode, official workshop stays online and community UI is never loaded.
      manifestReply.resolve({
        version: 2,
        safeMode: true,
        degraded: [],
        plugins: [
          { id: 'dstu.plugin-workshop', origin: 'builtin', platforms: ['desktop'] },
          { id: 'community.extra', origin: 'community', platforms: ['desktop'], file: '/plugins/extra/ui.js' },
        ],
      });
      await waitFor(() => expect(kernel.hostStatus.known).toBe(true));
      await kernel.settled();
      expect(kernel.hostStatus.state('dstu.plugin-workshop')).toBe('online');
      expect(kernel.list()).toEqual(['dstu.plugin-workshop']);
      expect(loadCommunity).not.toHaveBeenCalled();
    } finally {
      await stop();
      await kernel.dispose();
      Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
    }
  });
});

describe('G03b: hostGatedApp gates missing as well as degraded Host plugins', () => {
  it('shows HostUnavailablePanel when required host plugin is missing and restores the app when it comes online', async () => {
    const hostStatus = new UiHostStatusService();
    provideAppUiKernel({ hostStatus } as unknown as UiKernel);
    hostStatus.update({ plugins: [{ id: 'dstu.chat' }], degraded: [] });

    const onTitleChange = vi.fn();
    const WorkshopStub: React.FC<AppWindowProps> = () => <div data-testid="workshop-stub">ready</div>;
    const Gated = hostGatedApp('dstu.plugin-workshop', 'plugin_manager:workshop.label', async () => ({ default: WorkshopStub }));
    const props = { instanceId: 'pw-1', isActive: true, onTitleChange } as unknown as AppWindowProps;

    render(<React.Suspense fallback={null}><Gated {...props} /></React.Suspense>);

    expect(await screen.findByText(/dstu\.plugin-workshop/)).toBeInTheDocument();
    expect(screen.queryByTestId('workshop-stub')).toBeNull();
    expect(onTitleChange).toHaveBeenCalled();

    act(() => {
      hostStatus.update({ plugins: [{ id: 'dstu.chat' }, { id: 'dstu.plugin-workshop' }], degraded: [] });
    });

    expect(await screen.findByTestId('workshop-stub')).toBeInTheDocument();
  });
});

describe('G03b: WorkshopComposer & PluginWorkshopAppWindow availability alignment', () => {
  it('disables both textarea and submit with an explicit status banner when workshop is missing or lacks onSubmit', async () => {
    const { rerender } = render(<WorkshopComposer workshop={undefined} />);

    const textarea = screen.getByTestId('workshop-request');
    const submit = screen.getByTestId('workshop-submit');
    const banner = screen.getByTestId('workshop-composer-status');

    expect(textarea).toBeDisabled();
    expect(submit).toBeDisabled();
    expect(banner).toHaveAttribute('data-reason', 'unavailable');
    expect(textarea).toHaveAttribute('aria-describedby', banner.id);

    // Partial workshop binding without onSubmit also keeps textarea & submit aligned.
    const partial: PluginManagerWorkshop = { onCreate: vi.fn(), onModify: vi.fn(), creations: null };
    rerender(<WorkshopComposer workshop={partial} />);
    expect(screen.getByTestId('workshop-request')).toBeDisabled();
    expect(screen.getByTestId('workshop-submit')).toBeDisabled();
    expect(screen.getByTestId('workshop-composer-status')).toHaveAttribute('data-reason', 'submit-unavailable');

    // Safe mode shows explicit safe-mode explanation and disables both controls.
    const onSubmit = vi.fn(async () => undefined);
    const ready: PluginManagerWorkshop = { onCreate: vi.fn(), onModify: vi.fn(), onSubmit, creations: null };
    rerender(<WorkshopComposer workshop={ready} disabled safeMode />);
    expect(screen.getByTestId('workshop-request')).toBeDisabled();
    expect(screen.getByTestId('workshop-submit')).toBeDisabled();
    expect(screen.getByTestId('workshop-composer-status')).toHaveAttribute('data-reason', 'safe-mode');
    expect(screen.getByTestId('workshop-composer-status')).toHaveTextContent('安全模式');

    // Normal mode with workshop.onSubmit enables textarea & submit once text is entered.
    rerender(<WorkshopComposer workshop={ready} />);
    expect(screen.queryByTestId('workshop-composer-status')).toBeNull();
    expect(screen.getByTestId('workshop-request')).toBeEnabled();
    expect(screen.getByTestId('workshop-submit')).toBeDisabled();

    const user = userEvent.setup();
    await user.type(screen.getByTestId('workshop-request'), 'Build a compact study timer widget');
    expect(screen.getByTestId('workshop-submit')).toBeEnabled();

    await user.click(screen.getByTestId('workshop-submit'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Build a compact study timer widget'));
    expect(screen.getByTestId('workshop-request')).toHaveValue('');
  });

  it('PluginWorkshopAppWindow propagates Safe Mode and enables Build it with AI once workshop registers', async () => {
    const hostStatus = new UiHostStatusService();
    provideAppUiKernel({ hostStatus } as unknown as UiKernel);
    const props = { instanceId: 'pw-win', isActive: true, onTitleChange: vi.fn() } as unknown as AppWindowProps;

    render(<PluginWorkshopAppWindow {...props} />);
    // Before workshop registers, textarea & submit stay aligned disabled with an explicit status.
    expect(screen.getByTestId('workshop-request')).toBeDisabled();
    expect(screen.getByTestId('workshop-submit')).toBeDisabled();
    expect(screen.getByTestId('workshop-composer-status')).toHaveAttribute('data-reason', 'unavailable');
    expect(screen.getByTestId('workshop-app-unavailable')).toBeInTheDocument();

    const onSubmit = vi.fn(async () => undefined);
    let revoke: (() => void) | undefined;
    act(() => {
      revoke = registerPluginManagerWorkshop({
        onCreate: vi.fn(),
        onModify: vi.fn(),
        onSubmit,
        creations: <div data-testid="workshop-creations-stub">creations</div>,
      });
    });

    try {
      expect(screen.queryByTestId('workshop-composer-status')).toBeNull();
      expect(screen.getByTestId('workshop-creations-stub')).toBeInTheDocument();
      expect(screen.getByTestId('workshop-request')).toBeEnabled();

      const user = userEvent.setup();
      await user.type(screen.getByTestId('workshop-request'), 'Create a vocabulary review card');
      expect(screen.getByTestId('workshop-submit')).toBeEnabled();
      await user.click(screen.getByTestId('workshop-submit'));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Create a vocabulary review card'));

      // Switching to Safe Mode disables the window composer with explicit safe-mode status.
      act(() => { hostStatus.setSafeMode(true); });
      expect(screen.getByTestId('workshop-request')).toBeDisabled();
      expect(screen.getByTestId('workshop-submit')).toBeDisabled();
      expect(screen.getByTestId('workshop-composer-status')).toHaveAttribute('data-reason', 'safe-mode');
    } finally {
      act(() => { revoke?.(); });
    }
  });
});
