import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrepeEditorApi } from '@/components/crepe/types';
import {
  __resetMindMapStoreRegistry,
  createMindMapStore,
  registerMindMapStore,
} from '@/features/mindmap/store/mindmapStore';
import {
  registerWorkspaceHost,
  resetWorkspaceRegistryForTests,
} from '@/features/workbench/apps/notes/workspaceRegistry';
import { appRegistry } from '@/features/workbench/core/appRegistry';
import type { AppDefinition } from '@/features/workbench/core/types';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { resetWindowStoreForTests, useWindowStore } from '@/features/workbench/core/windowStore';
import {
  registerNoteEditor,
  unregisterNoteEditor,
} from '../drivers/noteDriver';

appRegistry.register({
  typeId: 'notes',
  nameKey: 'workbench:test.notes',
  icon: null,
  instanceMode: 'single',
  memoryWeight: 2,
  defaultFrame: { w: 900, h: 700 },
  minSize: { w: 400, h: 300 },
  render: null as unknown as AppDefinition['render'],
});

// ACR 4.0（A8 核对 d）：本套件路径全是微任务（无真实定时器），逻辑耗时 <10ms；
// 全量 vitest（forks 满载）时曾因 CPU 饿死偶发超过 5s 默认 testTimeout 而误报超时。
// 放宽超时上限只吸收调度抖动，不掩盖真实回归（真实挂死仍会在 20s 内暴露）。
describe('unified notes workspace ACR activation', { timeout: 20_000 }, () => {
  beforeEach(() => {
    resetWindowStoreForTests({ w: 1400, h: 900 });
    resetWorkspaceRegistryForTests();
    __resetMindMapStoreRegistry();
    workbenchBus.setEnabled(true);
  });

  afterEach(() => {
    unregisterNoteEditor('note-acr');
    workbenchBus.setEnabled(false);
    resetWorkspaceRegistryForTests();
    __resetMindMapStoreRegistry();
    resetWindowStoreForTests();
  });

  it('routes legacy note launch into one notes window and selects an internal tab', async () => {
    const firstWindowId = workbenchBus.launch({
      typeId: 'note',
      instanceKey: 'note-one',
      reason: 'api',
    });
    expect(firstWindowId).toBeTruthy();
    const openResource = vi.fn();
    registerWorkspaceHost(firstWindowId!, { openResource });

    const secondWindowId = workbenchBus.launch({
      typeId: 'mindmap',
      instanceKey: 'map-two',
      reason: 'api',
    });
    await Promise.resolve();

    expect(secondWindowId).toBe(firstWindowId);
    expect(Object.values(useWindowStore.getState().windows)).toHaveLength(1);
    expect(openResource).toHaveBeenCalledWith({ type: 'note', id: 'note-one' });
    expect(openResource).toHaveBeenCalledWith({ type: 'mindmap', id: 'map-two' });
  });

  it('selects the note tab before delivering scrollToHeading', async () => {
    const windowId = useWindowStore.getState().openWindow({ typeId: 'notes' });
    const openResource = vi.fn(async () => undefined);
    registerWorkspaceHost(windowId, { openResource });
    const scrollToHeading = vi.fn();
    registerNoteEditor('note-acr', { scrollToHeading } as unknown as CrepeEditorApi);

    await expect(workbenchBus.activateDetailed({
      typeId: 'note',
      instanceKey: 'note-acr',
      action: 'scrollToHeading',
      payload: { heading: '结论', level: 2 },
    })).resolves.toEqual({
      delivered: true,
      result: { handled: true, acknowledged: true },
    });
    expect(openResource).toHaveBeenCalledWith({ type: 'note', id: 'note-acr' });
    expect(scrollToHeading).toHaveBeenCalledWith('结论', 2);
  });

  it('delivers focusNode and setView to a resource store with a composite pane instance id', async () => {
    const windowId = useWindowStore.getState().openWindow({ typeId: 'notes' });
    registerWorkspaceHost(windowId, { openResource: vi.fn(async () => undefined) });
    const store = createMindMapStore();
    const rootId = store.getState().document.root.id;
    store.setState({ mindmapId: 'map-acr' });
    const unregister = registerMindMapStore(
      'map-acr',
      store,
      `${windowId}:right:mindmap:map-acr`,
    );
    const decoyStore = createMindMapStore();
    decoyStore.setState({ mindmapId: 'map-acr' });
    const unregisterDecoy = registerMindMapStore(
      'map-acr',
      decoyStore,
      'another-notes-window:left:mindmap:map-acr',
    );

    const focused = await workbenchBus.activateDetailed({
      typeId: 'mindmap',
      instanceKey: 'map-acr',
      action: 'focusNode',
      payload: { nodeId: rootId },
    });
    expect(focused).toEqual({
      delivered: true,
      result: { handled: true, acknowledged: true },
    });
    expect(store.getState().focusedNodeId).toBe(rootId);

    const view = await workbenchBus.activateDetailed({
      typeId: 'mindmap',
      instanceKey: 'map-acr',
      action: 'setView',
      payload: { view: 'outline' },
    });
    expect(view).toEqual({
      delivered: true,
      result: { handled: true, acknowledged: true },
    });
    expect(store.getState().currentView).toBe('outline');
    expect(decoyStore.getState().currentView).toBe('mindmap');
    unregisterDecoy();
    unregister();
  });
});
