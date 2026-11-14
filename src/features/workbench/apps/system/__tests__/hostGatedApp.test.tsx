import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { provideAppUiKernel } from '@/ui-kernel/app-kernel';
import type { UiKernel } from '@/ui-kernel/kernel';
import { UiHostStatusService } from '@/ui-kernel/services/host-status';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import type { AppWindowProps } from '../../../core/types';
import { ANKI_HOST_PLUGIN, hostGatedApp } from '../hostGatedApp';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const EmptyLibrary: React.FC<AppWindowProps> = () => <p>卡片库还是空的</p>;

function renderGated() {
  const onTitleChange = vi.fn();
  const Gated = hostGatedApp(ANKI_HOST_PLUGIN, 'workbench:apps.flashcards', async () => ({ default: EmptyLibrary }));
  const props = { instanceId: 'fc-1', isActive: true, onTitleChange } as unknown as AppWindowProps;
  render(<React.Suspense fallback={null}><Gated {...props} /></React.Suspense>);
  return { onTitleChange };
}

function publishKernel(): UiHostStatusService {
  const hostStatus = new UiHostStatusService();
  provideAppUiKernel({ hostStatus } as unknown as UiKernel);
  return hostStatus;
}

beforeAll(async () => {
  await import('@/components/system-status/HostUnavailablePanel');
});

afterEach(() => {
  provideAppUiKernel(undefined);
  useSystemStatusStore.getState().setComponentHealth([]);
});

// Rust 版没有 Host 插件；迁移后卡片数据由 Host 插件 dstu.anki 提供，它降级时工作台闪卡窗口照常渲染、拿到空列表，看起来像数据丢了。
describe('RF-W09-workbench-cards-host-degraded: card center windows follow the dstu.anki Host plugin', () => {
  it('shows the Host unavailable panel instead of an empty library while dstu.anki is degraded, and the app once it recovers', async () => {
    const hostStatus = publishKernel();
    hostStatus.update({ plugins: [{ id: ANKI_HOST_PLUGIN }], degraded: [{ id: ANKI_HOST_PLUGIN, reason: 'anki database locked' }] });
    const { onTitleChange } = renderGated();

    expect(await screen.findByText('anki database locked')).toBeInTheDocument();
    expect(screen.getByText('workbench:apps.flashcards')).toBeInTheDocument();
    expect(screen.queryByText('卡片库还是空的')).not.toBeInTheDocument();
    expect(onTitleChange).toHaveBeenCalledWith('workbench:apps.flashcards');
    expect(useSystemStatusStore.getState().componentHealth).toEqual([
      { component: `host:${ANKI_HOST_PLUGIN}`, status: 'degraded', reason: 'anki database locked', dependency: null },
    ]);

    act(() => hostStatus.update({ plugins: [{ id: ANKI_HOST_PLUGIN }], degraded: [] }));
    expect(await screen.findByText('卡片库还是空的')).toBeInTheDocument();
    expect(screen.queryByText('anki database locked')).not.toBeInTheDocument();
    expect(useSystemStatusStore.getState().componentHealth).toEqual([]);
  });

  it('switches to the panel when dstu.anki degrades while the window is open', async () => {
    const hostStatus = publishKernel();
    hostStatus.update({ plugins: [{ id: ANKI_HOST_PLUGIN }], degraded: [] });
    renderGated();
    expect(await screen.findByText('卡片库还是空的')).toBeInTheDocument();

    act(() => hostStatus.updateDegraded([{ id: ANKI_HOST_PLUGIN, reason: 'host plugin crashed' }]));
    expect(await screen.findByText('host plugin crashed')).toBeInTheDocument();
    expect(screen.queryByText('卡片库还是空的')).not.toBeInTheDocument();
  });

  it('renders the app when there is no app kernel or the Host status is not known yet', async () => {
    renderGated();
    expect(await screen.findByText('卡片库还是空的')).toBeInTheDocument();
  });
});
