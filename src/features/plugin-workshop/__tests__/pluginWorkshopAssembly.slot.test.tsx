import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const {
  dispatchAppEventMock,
  setPendingSettingsRouteMock,
  launchMock,
  openCandidateMock,
  listenMock,
  loadFailureCallbacks,
  mockRemote,
} = vi.hoisted(() => {
  const loadFailureCallbacks: Array<(failure: { id: string; version?: string; error: string }) => void> = [];
  const mockRemote = {
    list: vi.fn(async () => [] as any[]),
    developmentSkill: vi.fn(async () => ({ id: 'dstu-plugin-development', markdown: '# skill', schemaToolIds: [] })),
    storedData: vi.fn(async () => ({ keys: ['files/x.json'], bytes: 12 })),
    clearStoredData: vi.fn(async () => 1),
    reportValidation: vi.fn(async () => undefined),
    reportFault: vi.fn(async () => undefined),
    bindSession: vi.fn(async () => undefined),
  };
  return {
    dispatchAppEventMock: vi.fn(),
    setPendingSettingsRouteMock: vi.fn(),
    launchMock: vi.fn(() => 'win-1'),
    openCandidateMock: vi.fn(async () => undefined),
    listenMock: vi.fn(async () => () => {}),
    loadFailureCallbacks,
    mockRemote,
  };
});

vi.mock('@/features/plugin-manager/host-adapter', () => ({
  createHostPluginManagerAdapter: () => ({ list: async () => ({ plugins: [] }) }),
}));
vi.mock('@/events/app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/events/app')>()),
  dispatchAppEvent: dispatchAppEventMock,
}));
vi.mock('@/utils/pendingSettingsTab', () => ({
  setPendingSettingsRoute: setPendingSettingsRouteMock,
}));
vi.mock('@/shared/workbenchHost', () => ({
  getWorkbenchHostBridge: () => ({
    isEnabled: () => true,
    launch: launchMock,
  }),
}));
vi.mock('../open-candidate', () => ({
  openWorkshopCandidateView: openCandidateMock,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));
vi.mock('@/ui-kernel/community', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kernel/community')>()),
  subscribeCommunityUiLoadFailures: (cb: (failure: { id: string; version?: string; error: string }) => void) => {
    loadFailureCallbacks.push(cb);
    return () => {
      const idx = loadFailureCallbacks.indexOf(cb);
      if (idx >= 0) loadFailureCallbacks.splice(idx, 1);
    };
  },
}));

import { UiKernel } from '@/ui-kernel/kernel';
import plugin from '@/ui-plugins/official/plugin-workshop';
import '@/app/pluginWorkshop';
import type { WorkshopPlace } from '../types';

const capturedOpenView: { fn?: (pluginId: string, place?: WorkshopPlace) => Promise<void> } = {};
const capturedIntegration: { workshop?: any } = {};

vi.mock('../host-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host-adapter')>();
  return {
    ...actual,
    HostWorkshopAdapter: class extends actual.HostWorkshopAdapter {
      constructor(
        remote: any,
        manager: any,
        openPluginView: (pluginId: string, place?: WorkshopPlace) => Promise<void>,
        onFinished: any,
        files: any,
      ) {
        capturedOpenView.fn = openPluginView;
        super(remote, manager, openPluginView, onFinished, files);
      }
    },
  };
});

vi.mock('@/features/plugin-manager/workshop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/plugin-manager/workshop')>();
  return {
    ...actual,
    registerPluginManagerWorkshop: (w: any) => {
      capturedIntegration.workshop = w;
      return actual.registerPluginManagerWorkshop(w);
    },
  };
});

describe('src/app/pluginWorkshop.ts root assembly fixes', () => {
  let kernel: UiKernel;

  beforeEach(async () => {
    dispatchAppEventMock.mockClear();
    setPendingSettingsRouteMock.mockClear();
    launchMock.mockClear();
    openCandidateMock.mockClear();
    listenMock.mockClear();
    loadFailureCallbacks.length = 0;
    mockRemote.list.mockReset().mockResolvedValue([]);
    mockRemote.reportValidation.mockReset().mockResolvedValue(undefined);
    mockRemote.reportFault.mockReset().mockResolvedValue(undefined);
    mockRemote.storedData.mockReset().mockResolvedValue({ keys: ['files/x.json'], bytes: 12 });
    mockRemote.clearStoredData.mockReset().mockResolvedValue(1);

    kernel = new UiKernel({
      invoke: async (_cmd, args: any) => {
        const method = args?.method as keyof typeof mockRemote | undefined;
        if (method && typeof mockRemote[method] === 'function') {
          return (mockRemote[method] as any)(...(args.args ?? []));
        }
        return null;
      },
    });
    kernel.slots.declare({ name: 'pdf.selectionToolbar', cardinality: 'list' });
    kernel.slots.declare({ name: 'chat.composer.commands', cardinality: 'list' });
    kernel.slots.declare({ name: 'chat.message.actions', cardinality: 'list' });
    kernel.slots.declare({ name: 'review.cardActions', cardinality: 'list' });
    kernel.slots.declare({ name: 'desktop.widgets', cardinality: 'list' });
    kernel.slots.declare({ name: 'statusbar.items', cardinality: 'list' });
    kernel.slots.declare({ name: 'theme.variants', cardinality: 'list' });
    kernel.slots.declare({ name: 'dashboard.widgets', cardinality: 'list' });

    await kernel.install(plugin, { origin: 'builtin' });
  });

  afterEach(async () => {
    await kernel.dispose();
  });

  it('routes every new WorkshopPlace kind immediately and infers UI slot when place is undefined', async () => {
    const openView = capturedOpenView.fn!;
    expect(openView).toBeTypeOf('function');

    await openView('p.pdf', { kind: 'pdfSelectionButton' });
    expect(launchMock).toHaveBeenCalledWith({ typeId: 'files', reason: 'api' });

    await openView('p.slash', { kind: 'slashCommand', command: 'quiz' });
    expect(dispatchAppEventMock).toHaveBeenCalledWith('PREFILL_CHAT_INPUT', { content: '/quiz ', autoSend: false });
    expect(launchMock).toHaveBeenCalledWith({ typeId: 'chat', reason: 'api' });

    await openView('p.msg', { kind: 'chatMessageAction' });
    expect(launchMock).toHaveBeenCalledWith({ typeId: 'chat', reason: 'api' });

    await openView('p.rev', { kind: 'reviewAction' });
    expect(launchMock).toHaveBeenCalledWith({ typeId: 'flashcards', reason: 'api' });

    await openView('p.theme', { kind: 'themeVariant' });
    expect(setPendingSettingsRouteMock).toHaveBeenCalledWith({ tab: 'appearance' });
    expect(dispatchAppEventMock).toHaveBeenCalledWith('SETTINGS_NAVIGATE_TAB', { tab: 'appearance' });

    await openView('p.dash', { kind: 'dashboardWidget' });
    expect(dispatchAppEventMock).toHaveBeenCalledWith('NAVIGATE_TO_VIEW', { view: 'dashboard' });

    // Ambient slots return immediately in workbench mode without timeout
    await expect(openView('p.dw', { kind: 'desktopWidget' })).resolves.toBeUndefined();
    await expect(openView('p.sb', { kind: 'statusBarItem' })).resolves.toBeUndefined();

    // Unknown place infers contributed slot owner cleanly without waiting for views
    await kernel.install({
      meta: { id: 'community.pdf-auto', version: '1.0.0' },
      apply: (ctx) => ctx.ui.contribute('pdf.selectionToolbar', { id: 'b', value: { label: 'B', run: () => {} } }),
    }, { origin: 'community' });

    launchMock.mockClear();
    await openView('community.pdf-auto');
    expect(launchMock).toHaveBeenCalledWith({ typeId: 'files', reason: 'api' });
  });

  it('forwards storedData and clearStoredData from Host pluginWorkshop service', async () => {
    expect(await capturedIntegration.workshop.storedData('workshop.one')).toEqual({ keys: ['files/x.json'], bytes: 12 });
    expect(await capturedIntegration.workshop.clearStoredData('workshop.one')).toBe(1);
    expect(mockRemote.storedData).toHaveBeenCalledWith('workshop.one');
    expect(mockRemote.clearStoredData).toHaveBeenCalledWith('workshop.one');
  });

  it('prefixes community load failures with activate: while leaving runtime errors verbatim', async () => {
    const installedCard = {
      kind: 'dstu-plugin-workshop',
      id: 'card-err',
      pluginId: 'workshop.err',
      sessionId: 's1',
      title: 'Err',
      description: 'Desc',
      template: 'learning-tool',
      state: 'installed',
      revision: 3,
      version: '1.0.0',
      capabilities: [],
      changes: [],
      trust: 'full',
      source: 'workshop',
      risk: '',
      check: null,
      error: null,
      createdAt: '',
      updatedAt: '',
      installation: { state: 'installed', version: '1.0.0' },
    };
    mockRemote.list.mockResolvedValue([installedCard]);

    loadFailureCallbacks[0]?.({ id: 'workshop.err', version: '1.0.0', error: 'SyntaxError in ui module' });
    await vi.waitFor(() => {
      expect(mockRemote.reportFault).toHaveBeenCalledWith('card-err', 'activate: SyntaxError in ui module', '1.0.0');
    });

    kernel.errors.report({
      pluginId: 'workshop.err',
      origin: 'community',
      version: '1.0.0',
      phase: 'callback',
      slot: 'pdf.selectionToolbar',
      error: new Error('runtime explode'),
    });
    await vi.waitFor(() => {
      expect(mockRemote.reportFault).toHaveBeenCalledWith('card-err', 'callback: runtime explode', '1.0.0');
    });
  });

  it('waits for non-app UI slot contribution on pending validation without calling openWorkshopCandidateView', async () => {
    let verifyListener: (() => void) | undefined;
    listenMock.mockImplementation(async (_evt: string, cb: () => void) => {
      verifyListener = cb;
      return () => {};
    });

    const pendingPdfCard = {
      kind: 'dstu-plugin-workshop',
      id: 'card-pdf',
      pluginId: 'workshop.pdfbtn',
      sessionId: 's1',
      title: 'PDF Btn',
      description: 'Desc',
      template: 'learning-tool',
      state: 'installed',
      revision: 2,
      version: '1.2.0',
      capabilities: [],
      changes: [],
      trust: 'full',
      source: 'workshop',
      risk: '',
      check: null,
      error: null,
      createdAt: '',
      updatedAt: '',
      places: [{ kind: 'pdfSelectionButton' }],
      installation: { state: 'installed', version: '1.2.0' },
      validation: { version: '1.2.0', revision: 2, status: 'pending' },
    };
    mockRemote.list.mockResolvedValue([pendingPdfCard]);

    // Install matching version community UI contribution before refresh completes
    await kernel.install({
      meta: { id: 'workshop.pdfbtn', version: '1.2.0' },
      apply: (ctx) => ctx.ui.contribute('pdf.selectionToolbar', { id: 'p', value: { label: 'Pin', run: () => {} } }),
    }, { origin: 'community' });

    // Reinstall workshop plugin to pick up mock listen
    await kernel.unload(plugin.meta.id);
    await kernel.install(plugin, { origin: 'builtin' });

    verifyListener?.();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(openCandidateMock).not.toHaveBeenCalled();
    expect(mockRemote.reportValidation).not.toHaveBeenCalled();
  });
});
