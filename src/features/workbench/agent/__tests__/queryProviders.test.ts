/**
 * R1-08 — queryProviders WindowSummary 组装正确性
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetContentDirtyRegistry,
  registerContentDirtyChecker,
} from '../../apps/content/contentDirtyRegistry';
import { resetWindowListCacheForTests } from '../../core/windowListCache';
import { resetWindowStoreForTests, useWindowStore } from '../../core/windowStore';
import { registerTestApp } from '../../core/__tests__/testUtils';
import type { CollabDriver, StageManagerApi } from '../types';
import {
  buildWindowSummaries,
  registerBuiltinQueryProviders,
  type QueryStateCapableDriver,
} from '../queryProviders';

registerTestApp('note');
registerTestApp('chat', { instanceMode: 'single' });

function makeStage(): StageManagerApi & {
  providers: Map<string, (args: unknown) => unknown>;
  drivers: Map<string, CollabDriver>;
} {
  const providers = new Map<string, (args: unknown) => unknown>();
  const drivers = new Map<string, CollabDriver>();
  return {
    providers,
    drivers,
    registerDriver(driver) {
      drivers.set(driver.typeId, driver);
    },
    getDriver(typeId) {
      return drivers.get(typeId);
    },
    registerQueryProvider(scope, fn) {
      providers.set(scope, fn);
    },
    async handleBridgeRequest(req) {
      return { correlationId: req.correlationId, ok: false, error: 'test' };
    },
    async revertRun() {
      return false;
    },
    notifyUserInput() {},
    pauseRun() {},
    stopRun() {},
    start() {},
    stop() {},
  };
}

describe('queryProviders — WindowSummary', () => {
  beforeEach(() => {
    resetWindowStoreForTests({ w: 1400, h: 900 });
    resetWindowListCacheForTests();
    __resetContentDirtyRegistry();
    vi.clearAllMocks();
  });

  it('组装 windows：title 兜底、focused、dirty、lifecycle', () => {
    const store = useWindowStore.getState();
    const noteId = store.openWindow({
      typeId: 'note',
      instanceKey: 'note_1',
      title: '',
    });
    const chatId = store.openWindow({
      typeId: 'chat',
      title: '会话 A',
    });
    // chat 后开 → 应为焦点栈顶
    expect(useWindowStore.getState().focusStack.at(-1)).toBe(chatId);

    useWindowStore.getState().setLifecycles({
      [noteId]: 'visible',
      [chatId]: 'focused',
    });

    registerContentDirtyChecker('note', 'note_1', () => true);

    const result = buildWindowSummaries();
    expect(result.focused).toBe(chatId);
    expect(result.windows).toHaveLength(2);

    const note = result.windows.find((w) => w.windowId === noteId);
    const chat = result.windows.find((w) => w.windowId === chatId);
    expect(note).toMatchObject({
      windowId: noteId,
      typeId: 'note',
      instanceKey: 'note_1',
      focused: false,
      dirty: true,
      lifecycle: 'visible',
    });
    // 空 title → nameKey 兜底（i18n 未加载时回落 typeId 或 key）
    expect(typeof note?.title).toBe('string');
    expect(note!.title.length).toBeGreaterThan(0);

    expect(chat).toMatchObject({
      windowId: chatId,
      typeId: 'chat',
      instanceKey: null,
      title: '会话 A',
      focused: true,
      dirty: false,
      lifecycle: 'focused',
    });
  });

  it('registerBuiltinQueryProviders：list_windows / query_state', () => {
    const stage = makeStage();
    registerBuiltinQueryProviders(stage);

    const noteId = useWindowStore.getState().openWindow({
      typeId: 'note',
      instanceKey: 'n2',
      title: '笔记二',
    });
    useWindowStore.getState().setLifecycles({ [noteId]: 'focused' });

    const listFn = stage.providers.get('list_windows');
    expect(listFn).toBeTypeOf('function');
    const listed = listFn!() as ReturnType<typeof buildWindowSummaries>;
    expect(listed.focused).toBe(noteId);
    expect(listed.windows[0]).toMatchObject({
      windowId: noteId,
      typeId: 'note',
      title: '笔记二',
      focused: true,
    });

    const queryFn = stage.providers.get('query_state');
    expect(queryFn).toBeTypeOf('function');
    const focused = queryFn!({ scope: 'focused' }) as Record<string, unknown>;
    expect(focused).toMatchObject({
      windowId: noteId,
      typeId: 'note',
      title: '笔记二',
      instanceKey: 'n2',
      lifecycle: 'focused',
    });

    const byId = queryFn!({ scope: 'window', windowId: noteId }) as Record<string, unknown>;
    expect(byId.windowId).toBe(noteId);

    const missing = queryFn!({ scope: 'window', windowId: 'nope' }) as {
      code: string;
    };
    expect(missing.code).toBe('WINDOW_NOT_FOUND');
  });

  it('query_state 合并 driver.queryState 扩展（鸭子探测）', () => {
    const stage = makeStage();
    registerBuiltinQueryProviders(stage);

    const noteId = useWindowStore.getState().openWindow({
      typeId: 'note',
      instanceKey: 'n3',
      title: '扩展笔记',
    });

    const driver: QueryStateCapableDriver = {
      typeId: 'note',
      probe: () => 'clean',
      async apply() {
        return {
          status: 'completed',
          mode: 'frontend',
          applied: 0,
          totalOps: 0,
          entityIds: [],
          done: [],
          undone: [],
        };
      },
      abort() {
        return {
          status: 'cancelled',
          mode: 'frontend',
          applied: 0,
          totalOps: 0,
          entityIds: [],
          done: [],
          undone: [],
        };
      },
      queryState: () => ({ heading: '引言', cursorOffset: 12 }),
    };
    stage.registerDriver(driver);

    const queryFn = stage.providers.get('query_state')!;
    const result = queryFn({ scope: 'window', windowId: noteId }) as Record<string, unknown>;
    expect(result).toMatchObject({
      windowId: noteId,
      typeId: 'note',
      heading: '引言',
      cursorOffset: 12,
    });
  });
});
