/**
 * A45-3（docs/dev/acr/ACR-4.5.md）— desktop 全局搜索能力测试
 *
 * mock 四个 provider（search/globalSearchProviders 整体替身），覆盖：
 * - globalSearch 查询返回结构（kind/id/label/sublabel/ref/openAction、前缀剥离）
 * - kinds 过滤与非法 kinds / limit 校验
 * - provider 超时（3s 结构化失败，不悬挂）与部分降级路径
 * - openSearchResult 各 kind 分派（app/dstu/chat/command）
 * - 无效 kind / 缺 id 的 INVALID_ARGS
 * - observe 的 availableActions 与 searchAvailable 增补
 *
 * 本轮纪律：测试只写不跑（协调者统一验收）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── 替身：i18n 与全局通知（agentManifest 的模块级依赖，避免拉起真实 i18n 栈） ──
vi.mock('i18next', () => ({
  default: {
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
    language: 'en-US',
  },
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

// ── 替身：⌘K 四 provider（可控返回 / 挂起 / 抛错，并记录被查询的 kind） ──
interface MockSearchItem {
  id: string;
  kind: 'app' | 'command' | 'dstu' | 'chat';
  title: string;
  subtitle?: string;
  score: number;
  open: () => void | Promise<void>;
}

interface MockDstuNode {
  id: string;
  path: string;
  name: string;
  type: string;
}

const searchMocks = vi.hoisted(() => ({
  appItems: [] as unknown[],
  commandItems: [] as unknown[],
  dstuItems: [] as unknown[],
  chatItems: [] as unknown[],
  dstuNodes: [] as unknown[],
  hangKinds: new Set<string>(),
  errorKinds: new Map<string, Error>(),
  searchedKinds: [] as string[],
  openChatWindowId: null as string | null,
  openChatCalls: [] as string[],
  reset() {
    this.appItems = [];
    this.commandItems = [];
    this.dstuItems = [];
    this.chatItems = [];
    this.dstuNodes = [];
    this.hangKinds.clear();
    this.errorKinds.clear();
    this.searchedKinds = [];
    this.openChatWindowId = null;
    this.openChatCalls = [];
  },
}));

vi.mock('../../../search/globalSearchProviders', () => {
  const runSearch = (kind: string, items: () => unknown[]) => {
    searchMocks.searchedKinds.push(kind);
    const error = searchMocks.errorKinds.get(kind);
    if (error) return Promise.reject(error);
    if (searchMocks.hangKinds.has(kind)) {
      // 永不 resolve：验证 3s 超时后 abort 收口，不悬挂
      return new Promise<never>(() => {});
    }
    return Promise.resolve(items());
  };
  return {
    createAppsProvider: () => ({
      id: 'apps', kind: 'app', debounceMs: 0, minChars: 0,
      search: () => runSearch('app', () => searchMocks.appItems),
    }),
    createCommandsProvider: () => ({
      id: 'commands', kind: 'command', debounceMs: 0, minChars: 1,
      search: () => runSearch('command', () => searchMocks.commandItems),
    }),
    createDstuProviderWithNodeCapture: (
      _host: unknown,
      onNodes: (nodes: unknown[]) => void,
    ) => ({
      id: 'dstu', kind: 'dstu', debounceMs: 250, minChars: 2,
      search: () => {
        const promise = runSearch('dstu', () => searchMocks.dstuItems);
        return promise.then((items) => {
          onNodes(searchMocks.dstuNodes);
          return items;
        });
      },
    }),
    createChatProvider: () => ({
      id: 'chat', kind: 'chat', debounceMs: 250, minChars: 2,
      search: () => runSearch('chat', () => searchMocks.chatItems),
    }),
    openChatInWorkbenchForAgent: (sessionId: string) => {
      searchMocks.openChatCalls.push(sessionId);
      return searchMocks.openChatWindowId;
    },
    openDstuInWorkbench: vi.fn(),
  };
});

import { commandRegistry } from '@/command-palette/registry/commandRegistry';
import type { Command, DependencyResolver } from '@/command-palette/registry/types';
import { resetWindowListCacheForTests } from '../../../core/windowListCache';
import { resetActiveTilingPairCacheForTests } from '../../../core/tiling';
import { resetWindowStoreForTests, useWindowStore } from '../../../core/windowStore';
import { workbenchBus } from '../../../core/workbenchBus';
import { registerTestApp } from '../../../core/__tests__/testUtils';
import { setAgentControlMode } from '../../../agent/gates';
import type { AgentActionResult } from '../../../core/types';
import { desktopAgentManifest } from '../agentManifest';

const CTX = { windowId: 'desktop', typeId: 'desktop', instanceKey: null };

registerTestApp('gs-note-app', { instanceMode: 'multi' });
registerTestApp('exam', { instanceMode: 'multi' });
registerTestApp('chat', { instanceMode: 'single' });

function appItem(typeId: string, title: string, index = 0): MockSearchItem {
  return {
    id: `app:${typeId}`, kind: 'app', title, subtitle: typeId,
    score: 1 - index * 0.05, open: () => {},
  };
}

function dstuItem(node: MockDstuNode, index = 0): MockSearchItem {
  return {
    id: `dstu:${node.id}`, kind: 'dstu', title: node.name, subtitle: node.path,
    score: (1 - index * 0.05) * 0.85, open: () => {},
  };
}

async function execute(
  name: string,
  args: Record<string, unknown>,
): Promise<AgentActionResult> {
  return (await desktopAgentManifest.execute!(CTX, { name, args })) as AgentActionResult;
}

function registerCommand(overrides: Partial<Command> & Pick<Command, 'id'>): () => void {
  return commandRegistry.register({
    name: overrides.id,
    category: 'global',
    execute: () => {},
    ...overrides,
  } as Command);
}

beforeEach(() => {
  resetWindowStoreForTests({ w: 1400, h: 900 });
  resetWindowListCacheForTests();
  resetActiveTilingPairCacheForTests();
  workbenchBus.setEnabled(true);
  setAgentControlMode('follow');
  searchMocks.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('desktop globalSearch — 契约形状', () => {
  it('声明为 read 级纯数据能力；openSearchResult 为 medium 不可撤', () => {
    const byName = Object.fromEntries(
      desktopAgentManifest.capabilities.map((capability) => [capability.name, capability]),
    );
    expect(byName.globalSearch).toMatchObject({
      risk: 'read', mutates: false, reversible: false, idempotent: true,
    });
    expect(byName.openSearchResult).toMatchObject({
      risk: 'medium', mutates: true, reversible: false, idempotent: false,
    });
  });

  it('observe：availableActions 增补两能力，state.searchAvailable=true', async () => {
    const observation = await desktopAgentManifest.observe!(CTX);
    expect(observation.availableActions).toEqual(
      expect.arrayContaining(['globalSearch', 'openSearchResult']),
    );
    expect(observation.state).toMatchObject({ searchAvailable: true });
  });
});

describe('desktop globalSearch — 查询返回结构', () => {
  it('结构化返回 kind/id/label/sublabel/ref/openAction，条目 id 剥掉 provider 前缀', async () => {
    searchMocks.appItems = [appItem('gs-note-app', '笔记应用')];
    searchMocks.dstuNodes = [
      { id: 'note_1', name: '函数笔记', path: '/高考/函数', type: 'note' },
    ];
    searchMocks.dstuItems = [
      dstuItem({ id: 'note_1', name: '函数笔记', path: '/高考/函数', type: 'note' }),
    ];
    searchMocks.chatItems = [{
      id: 'chat:sess_1', kind: 'chat', title: '函数讨论', subtitle: '……函数图像……',
      score: 0.8, open: () => {},
    }];

    const result = await execute('globalSearch', { query: '函数' });
    expect(result.handled).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.acknowledged).toBe(true);
    const details = result.details!;
    expect(details.totalItems).toBe(3);
    expect(details.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'app', id: 'gs-note-app', label: '笔记应用', sublabel: 'gs-note-app',
        ref: 'desktop:search:app:gs-note-app',
        openAction: { name: 'openSearchResult', args: { kind: 'app', id: 'gs-note-app' } },
      }),
      expect.objectContaining({
        kind: 'dstu', id: 'note_1', label: '函数笔记', sublabel: '/高考/函数',
        ref: 'desktop:search:dstu:note_1',
      }),
      expect.objectContaining({
        kind: 'chat', id: 'sess_1', label: '函数讨论',
        ref: 'desktop:search:chat:sess_1',
      }),
    ]));
    // command provider 无结果但被查询过（四 provider 全量并行）
    expect(searchMocks.searchedKinds.sort()).toEqual(['app', 'chat', 'command', 'dstu']);
  });

  it('limit 逐 kind 截断；非法 limit / 空 query 结构化拒绝', async () => {
    searchMocks.appItems = Array.from({ length: 10 }, (_, i) =>
      appItem(`app-${i}`, `应用 ${i}`, i));
    const result = await execute('globalSearch', { query: 'app', kinds: ['app'], limit: 3 });
    expect(result.handled).toBe(true);
    expect(result.details!.totalItems).toBe(3);

    const badLimit = await execute('globalSearch', { query: 'x', limit: 0 });
    expect(badLimit).toMatchObject({ handled: false, code: 'INVALID_ARGS' });
    const emptyQuery = await execute('globalSearch', { query: '   ' });
    expect(emptyQuery).toMatchObject({ handled: false, code: 'INVALID_ARGS' });
  });

  it('短 query 跳过 minChars 不足的 provider，并在 degradedKinds 里如实报告', async () => {
    const result = await execute('globalSearch', { query: 'a', kinds: ['dstu'] });
    expect(result.handled).toBe(true);
    expect(result.details!.totalItems).toBe(0);
    expect(result.details!.degradedKinds).toEqual([
      expect.objectContaining({ kind: 'dstu', status: 'skipped' }),
    ]);
    // provider 根本不该被调用
    expect(searchMocks.searchedKinds).toEqual([]);
  });
});

describe('desktop globalSearch — kinds 过滤', () => {
  it('kinds 只跑请求的 provider', async () => {
    searchMocks.appItems = [appItem('gs-note-app', '笔记应用')];
    const result = await execute('globalSearch', { query: 'note', kinds: ['app', 'command'] });
    expect(result.handled).toBe(true);
    expect(searchMocks.searchedKinds.sort()).toEqual(['app', 'command']);
    const items = result.details!.items as Array<{ kind: string }>;
    expect(items.every((item) => item.kind === 'app' || item.kind === 'command')).toBe(true);
  });

  it('非法 / 空 kinds → INVALID_ARGS', async () => {
    expect(await execute('globalSearch', { query: 'x', kinds: ['bogus'] }))
      .toMatchObject({ handled: false, code: 'INVALID_ARGS' });
    expect(await execute('globalSearch', { query: 'x', kinds: [] }))
      .toMatchObject({ handled: false, code: 'INVALID_ARGS' });
    expect(await execute('globalSearch', { query: 'x', kinds: 'app' }))
      .toMatchObject({ handled: false, code: 'INVALID_ARGS' });
  });
});

describe('desktop globalSearch — 超时与失败路径', () => {
  it('provider 挂起 3s 后结构化超时（SEARCH_TIMEOUT），不悬挂', async () => {
    vi.useFakeTimers();
    searchMocks.hangKinds.add('dstu');
    const pending = execute('globalSearch', { query: '函数', kinds: ['dstu'] });
    await vi.advanceTimersByTimeAsync(3100);
    const result = await pending;
    expect(result).toMatchObject({ handled: false, code: 'SEARCH_TIMEOUT' });
    expect(result.hint).toContain('dstu');
  });

  it('部分 provider 超时 → 其余结果可用并在 degradedKinds/message 里降级说明', async () => {
    vi.useFakeTimers();
    searchMocks.appItems = [appItem('gs-note-app', '笔记应用')];
    searchMocks.hangKinds.add('chat');
    const pending = execute('globalSearch', { query: '函数', kinds: ['app', 'chat'] });
    await vi.advanceTimersByTimeAsync(3100);
    const result = await pending;
    expect(result.handled).toBe(true);
    expect(result.details!.totalItems).toBe(1);
    expect(result.details!.degradedKinds).toEqual([
      expect.objectContaining({ kind: 'chat', status: 'timeout' }),
    ]);
    expect(result.message).toContain('chat');
  });

  it('provider 抛错且无可用结果 → SEARCH_FAILED', async () => {
    searchMocks.errorKinds.set('dstu', new Error('后端 FTS 挂了'));
    const result = await execute('globalSearch', { query: '函数', kinds: ['dstu'] });
    expect(result).toMatchObject({ handled: false, code: 'SEARCH_FAILED' });
    expect(result.hint).toContain('后端 FTS 挂了');
  });
});

describe('desktop openSearchResult — 各 kind 分派', () => {
  it('app → 走 launchApp 路径真实开窗', async () => {
    const result = await execute('openSearchResult', { kind: 'app', id: 'gs-note-app' });
    expect(result.handled).toBe(true);
    expect(result.changed).toBe(true);
    const windowId = (result.details as { windowId: string }).windowId;
    expect(useWindowStore.getState().windows[windowId]?.typeId).toBe('gs-note-app');
  });

  it('dstu → 用缓存节点映射应用并携带 resourceId 开窗', async () => {
    searchMocks.dstuNodes = [
      { id: 'exam_1', name: '一模卷', path: '/试卷/一模卷', type: 'exam' },
    ];
    searchMocks.dstuItems = [
      dstuItem({ id: 'exam_1', name: '一模卷', path: '/试卷/一模卷', type: 'exam' }),
    ];
    await execute('globalSearch', { query: '一模', kinds: ['dstu'] });

    const result = await execute('openSearchResult', { kind: 'dstu', id: 'exam_1' });
    expect(result.handled).toBe(true);
    expect(result.changed).toBe(true);
    const windowId = (result.details as { windowId: string }).windowId;
    expect(useWindowStore.getState().windows[windowId]?.typeId).toBe('exam');
    expect(result.details).toMatchObject({
      searchResult: { kind: 'dstu', id: 'exam_1', label: '一模卷' },
    });
  });

  it('dstu 未缓存（未先 globalSearch）→ RESULT_EXPIRED', async () => {
    const result = await execute('openSearchResult', { kind: 'dstu', id: 'ghost_404' });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'RESULT_EXPIRED' });
  });

  it('chat → 打开会话窗并以窗口存在作为权威确认', async () => {
    const windowId = useWindowStore.getState().openWindow({
      typeId: 'chat', title: '会话', instanceKey: 'sess_1',
    });
    searchMocks.openChatWindowId = windowId;
    const result = await execute('openSearchResult', { kind: 'chat', id: 'sess_1' });
    expect(searchMocks.openChatCalls).toEqual(['sess_1']);
    expect(result).toMatchObject({
      handled: true, changed: true, acknowledged: true,
      details: { windowId, sessionId: 'sess_1' },
    });
  });

  it('chat 在桌面未启用（launch 返回 null）时 → DISABLED', async () => {
    searchMocks.openChatWindowId = null;
    const result = await execute('openSearchResult', { kind: 'chat', id: 'sess_x' });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'DISABLED' });
  });

  it('command → 经命令注册表真实执行；副作用如实 acknowledged=false', async () => {
    const run = vi.fn();
    const unregister = registerCommand({ id: 'test.agent-ok', name: '测试命令', execute: run });
    try {
      const result = await execute('openSearchResult', { kind: 'command', id: 'test.agent-ok' });
      expect(run).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        handled: true, changed: true, acknowledged: false,
        details: { commandId: 'test.agent-ok' },
      });
    } finally {
      unregister();
    }
  });

  it('command 依赖应用壳（navigate 等）→ COMMAND_NEEDS_SHELL 结构化失败', async () => {
    const unregister = registerCommand({
      id: 'test.agent-shell',
      name: '需要壳的命令',
      execute: (deps: DependencyResolver) => {
        deps.navigate('home' as never);
      },
    });
    try {
      const result = await execute('openSearchResult', { kind: 'command', id: 'test.agent-shell' });
      expect(result).toMatchObject({ handled: false, changed: false, code: 'COMMAND_NEEDS_SHELL' });
    } finally {
      unregister();
    }
  });

  it('command 危险/需确认或不在 workbench 视图 → 不代执行', async () => {
    const dangerousRun = vi.fn();
    const unregisterDangerous = registerCommand({
      id: 'test.agent-danger', name: '危险命令', dangerous: true, execute: dangerousRun,
    });
    const unregisterScoped = registerCommand({
      id: 'test.agent-settings-only',
      name: '仅 settings 视图',
      visibleInViews: ['settings'],
      execute: vi.fn(),
    });
    try {
      expect(await execute('openSearchResult', { kind: 'command', id: 'test.agent-danger' }))
        .toMatchObject({ handled: false, code: 'CONFIRM_REQUIRED' });
      expect(dangerousRun).not.toHaveBeenCalled();
      expect(await execute('openSearchResult', { kind: 'command', id: 'test.agent-settings-only' }))
        .toMatchObject({ handled: false, code: 'ACTION_UNAVAILABLE' });
      expect(await execute('openSearchResult', { kind: 'command', id: 'test.missing' }))
        .toMatchObject({ handled: false, code: 'COMMAND_NOT_FOUND' });
    } finally {
      unregisterDangerous();
      unregisterScoped();
    }
  });

  it('无效 kind / 缺 id → INVALID_ARGS', async () => {
    expect(await execute('openSearchResult', { kind: 'bogus', id: 'x' }))
      .toMatchObject({ handled: false, code: 'INVALID_ARGS' });
    expect(await execute('openSearchResult', { kind: 'app', id: '   ' }))
      .toMatchObject({ handled: false, code: 'INVALID_ARGS' });
    expect(await execute('openSearchResult', { kind: 'app' }))
      .toMatchObject({ handled: false, code: 'INVALID_ARGS' });
  });
});
