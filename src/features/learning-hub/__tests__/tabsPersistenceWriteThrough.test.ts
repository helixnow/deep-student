/**
 * P8-1「savePersistedTabs 写透缓存」行为测试（0824 Wave2-B 第 7 轮，测试员-5）
 *
 * 本轮只写不跑；预期第 8 轮跑测全绿。
 *
 * 现状（写作本文件时）：savePersistedTabs / loadPersistedTabs 是
 * LearningHubPage.tsx 的模块私有纯函数（未导出），且本轮禁改
 * LearningHubPage 实现，无法 import 做行为断言。本文件采用与
 * closeTabGate.test.ts 第 2 轮相同的探测式写法：依次探测候选模块路径，
 * 若第 8 轮实现员把持久化纯函数抽成独立模块（推荐命名 tabsPersistence，
 * 导出 savePersistedTabs / loadPersistedTabs，并为测试提供缓存重置钩子
 * __resetPersistedTabsCache），本组行为测试自动激活；未抽出则整组 skip
 * （非红灯——同语义的源码契约防线见同目录 tabRestoreRebind.source.test.ts）。
 *
 * 行为契约（docs/dev/wave2-B-r3-tab-restore.md P8-1）：
 * - save 先写透模块级缓存再写 localStorage；
 * - 同 renderer 内 Page 卸载重挂（= load 再次被调）读到的是缓存里的最新
 *   快照，而非 localStorage 里可能过期的数据；
 * - localStorage 不可用（setItem 抛异常）时 save 不抛、缓存照常更新；
 * - 持久化 payload 版本化（version=2），存储 key 沿用 learning-hub-tabs-v1。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTab, type OpenTab } from '../types/tabs';

// 与 LearningHubPage.tsx 的 TABS_STORAGE_KEY / TABS_STORAGE_VERSION 对齐
// （key 沿用 v1 避免升级丢历史标签；版本号在 payload 内）
const TABS_STORAGE_KEY = 'learning-hub-tabs-v1';
const TABS_STORAGE_VERSION = 2;

interface PersistedTabsState {
  tabs: OpenTab[];
  activeTabId: string | null;
}

interface TabsPersistenceApi {
  save: (tabs: OpenTab[], activeTabId: string | null) => void;
  load: () => PersistedTabsState;
  /** 测试钩子：清空模块级缓存，模拟「重启」后首次 load 走 localStorage 解析 */
  reset: (() => void) | null;
}

// ---------------------------------------------------------------------------
// 目标模块动态加载：实现员可能落在 hub 根 / utils / stores / types 下，
// 依次探测；全部缺失 → 整组 skip（原因见文件头）
// ---------------------------------------------------------------------------

const CANDIDATE_PATHS = [
  '../tabsPersistence',
  '../utils/tabsPersistence',
  '../stores/tabsPersistence',
  '../types/tabsPersistence',
];

const RESET_EXPORT_NAMES = [
  '__resetPersistedTabsCache',
  'resetPersistedTabsCache',
  '__resetTabsPersistenceForTest',
];

let api: TabsPersistenceApi | null = null;
for (const candidate of CANDIDATE_PATHS) {
  try {
    // @vite-ignore：模块在实现员抽出前不存在，留给运行时解析而非转换期报错
    const mod = (await import(/* @vite-ignore */ candidate)) as Record<string, unknown>;
    if (
      typeof mod.savePersistedTabs === 'function' &&
      typeof mod.loadPersistedTabs === 'function'
    ) {
      const resetName = RESET_EXPORT_NAMES.find((name) => typeof mod[name] === 'function');
      api = {
        save: mod.savePersistedTabs as TabsPersistenceApi['save'],
        load: mod.loadPersistedTabs as TabsPersistenceApi['load'],
        reset: resetName ? (mod[resetName] as () => void) : null,
      };
      break;
    }
  } catch {
    // 该候选路径不存在，继续探测下一个
  }
}

const describeIfExtracted = api ? describe : describe.skip;

function makeTab(resourceId: string, overrides: Partial<OpenTab> = {}): OpenTab {
  return {
    ...createTab({
      type: 'note',
      resourceId,
      title: `title-${resourceId}`,
      dstuPath: `/${resourceId}`,
    }),
    ...overrides,
  };
}

describeIfExtracted('savePersistedTabs 写透模块级缓存（P8-1）', () => {
  beforeEach(() => {
    localStorage.clear();
    api?.reset?.();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('save 后 load 命中缓存快照，而非 localStorage 里的过期数据', () => {
    const tabA = makeTab('res-a');
    const tabB = makeTab('res-b');
    api!.save([tabA, tabB], tabB.tabId);

    // 直接把 localStorage 篡改成过期快照，模拟 r1 §2a 的时序窗口：
    // 若 save 只写 storage 不写缓存，重挂后的 load 会读到这份旧数据，
    // 首次持久化 effect 随即用它覆盖回 localStorage（会话内新标签被回滚）
    const staleTab = makeTab('res-stale');
    localStorage.setItem(
      TABS_STORAGE_KEY,
      JSON.stringify({ version: TABS_STORAGE_VERSION, tabs: [staleTab], activeTabId: staleTab.tabId }),
    );

    const snapshot = api!.load();
    expect(snapshot.tabs.map((t) => t.resourceId)).toEqual(['res-a', 'res-b']);
    expect(snapshot.activeTabId).toBe(tabB.tabId);
  });

  it('localStorage.setItem 抛异常时 save 不抛，缓存仍更新且 load 可恢复', () => {
    const tab = makeTab('res-quota');
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      });

    expect(() => api!.save([tab], tab.tabId)).not.toThrow();
    setItemSpy.mockRestore();

    // storage 写失败但缓存已写透：同会话内 remount 的恢复不受影响
    const snapshot = api!.load();
    expect(snapshot.tabs.map((t) => t.resourceId)).toEqual(['res-quota']);
    expect(snapshot.activeTabId).toBe(tab.tabId);
  });

  it('落盘 payload 版本化（version=2）且沿用 v1 存储 key', () => {
    const tab = makeTab('res-versioned');
    api!.save([tab], tab.tabId);

    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const payload = JSON.parse(raw!) as {
      version?: unknown;
      tabs?: unknown;
      activeTabId?: unknown;
    };
    expect(payload.version).toBe(TABS_STORAGE_VERSION);
    expect(Array.isArray(payload.tabs)).toBe(true);
    expect(payload.activeTabId).toBe(tab.tabId);
  });

  // 「重启」路径需要缓存重置钩子：没有钩子时无法在同进程内模拟冷启动
  (api?.reset ? it : it.skip)(
    '重启（缓存清空）后 load 从 localStorage 重新解析出同一份标签',
    () => {
      const tabA = makeTab('res-restart-a');
      const tabB = makeTab('res-restart-b');
      api!.save([tabA, tabB], tabA.tabId);

      api!.reset!();

      const snapshot = api!.load();
      expect(snapshot.tabs.map((t) => t.resourceId)).toEqual(['res-restart-a', 'res-restart-b']);
      expect(snapshot.tabs.map((t) => t.tabId)).toEqual([tabA.tabId, tabB.tabId]);
      expect(snapshot.activeTabId).toBe(tabA.tabId);
    },
  );
});
