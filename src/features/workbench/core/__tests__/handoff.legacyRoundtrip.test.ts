/**
 * handoff.legacyRoundtrip（0824 Wave2-B r7 测试员-8）— 交接 descriptor
 * 的存取往返 + Workbench→经典壳焦点交接落盘。
 *
 * 口径（接缝三 · r5 handoff-1）：
 * - build+save 后 consume 得到同一 appType/resourceId（资源级往返无损）；
 * - 消费一次即清：二次 consume → null，存储条目已删除；
 * - handoffWorkbenchToLegacyShell 在有焦点窗（命中经典壳映射）时把
 *   descriptor 写入默认 storage（localStorage）；无焦点窗时不写不返回。
 *
 * windowStore 全程 mock：本文件只测交接链路本身，不驱动真实内核状态；
 * workbenchBus / 通知 / i18n 同步 mock 掉，避免拉起无关依赖链。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const windowStoreState = vi.hoisted(() => ({
  windows: {} as Record<string, { typeId: string; instanceKey: string | null }>,
  focusStack: [] as string[],
}));

vi.mock('../windowStore', () => ({
  useWindowStore: { getState: () => windowStoreState },
}));
vi.mock('../workbenchBus', () => ({
  workbenchBus: { registerLegacyFallback: vi.fn() },
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));
vi.mock('@/utils/i18n', () => ({
  t: (key: string) => key,
}));

import {
  HANDOFF_DESCRIPTOR_VERSION,
  WORKBENCH_HANDOFF_STORAGE_KEY,
  buildHandoffDescriptor,
  consumeHandoffDescriptor,
  saveHandoffDescriptor,
} from '../handoffDescriptor';
import { handoffWorkbenchToLegacyShell } from '../legacyNavigationMap';

type MemoryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  entries: Map<string, string>;
};

function makeMemoryStorage(): MemoryStorage {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

beforeEach(() => {
  windowStoreState.windows = {};
  windowStoreState.focusStack = [];
  localStorage.removeItem(WORKBENCH_HANDOFF_STORAGE_KEY);
});

afterEach(() => {
  localStorage.removeItem(WORKBENCH_HANDOFF_STORAGE_KEY);
});

describe('descriptor 存取往返（build + save → consume）', () => {
  it('save 后 consume 得到同一 appType/resourceId（与 build 结果逐字段一致）', () => {
    const storage = makeMemoryStorage();
    const context = { appType: 'note', resourceId: 'res-42', innerRoute: 'page:3' };

    const built = buildHandoffDescriptor(context, 1_000);
    const saved = saveHandoffDescriptor(context, storage, 1_000);
    expect(saved).toEqual(built);
    expect(storage.entries.has(WORKBENCH_HANDOFF_STORAGE_KEY)).toBe(true);

    const consumed = consumeHandoffDescriptor({ storage, now: 2_000 });
    expect(consumed).not.toBeNull();
    expect(consumed!.appType).toBe('note');
    expect(consumed!.resourceId).toBe('res-42');
    expect(consumed!.innerRoute).toBe('page:3');
    expect(consumed!.version).toBe(HANDOFF_DESCRIPTOR_VERSION);
    expect(consumed).toEqual(saved);
  });

  it('二次 consume 为 null，且存储条目在首次 consume 时已删除', () => {
    const storage = makeMemoryStorage();
    saveHandoffDescriptor({ appType: 'textbook', resourceId: 'tb-7' }, storage, 1_000);

    const first = consumeHandoffDescriptor({ storage, now: 1_500 });
    expect(first).not.toBeNull();
    expect(storage.entries.has(WORKBENCH_HANDOFF_STORAGE_KEY)).toBe(false);

    const second = consumeHandoffDescriptor({ storage, now: 1_600 });
    expect(second).toBeNull();
  });
});

describe('handoffWorkbenchToLegacyShell（焦点交接落盘）', () => {
  it('有焦点窗时把 descriptor 写入 localStorage 并返回同一三元组', () => {
    windowStoreState.windows = {
      win_note: { typeId: 'note', instanceKey: 'res-legacy-1' },
    };
    windowStoreState.focusStack = ['win_note'];

    const result = handoffWorkbenchToLegacyShell();
    expect(result).not.toBeNull();
    expect(result!.appType).toBe('note');
    expect(result!.resourceId).toBe('res-legacy-1');

    const raw = localStorage.getItem(WORKBENCH_HANDOFF_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!) as Record<string, unknown>;
    expect(persisted.version).toBe(HANDOFF_DESCRIPTOR_VERSION);
    expect(persisted.appType).toBe('note');
    expect(persisted.resourceId).toBe('res-legacy-1');
  });

  it('落盘后可被 consume 取回同一 appType/resourceId（跨壳往返闭环）', () => {
    windowStoreState.windows = {
      win_tb: { typeId: 'textbook', instanceKey: 'tb-roundtrip' },
    };
    windowStoreState.focusStack = ['win_tb'];

    const handed = handoffWorkbenchToLegacyShell();
    expect(handed).not.toBeNull();

    const consumed = consumeHandoffDescriptor({ now: handed!.savedAt + 1 });
    expect(consumed).not.toBeNull();
    expect(consumed!.appType).toBe(handed!.appType);
    expect(consumed!.resourceId).toBe(handed!.resourceId);
  });

  it('无焦点窗时返回 null 且不写 storage', () => {
    const result = handoffWorkbenchToLegacyShell();
    expect(result).toBeNull();
    expect(localStorage.getItem(WORKBENCH_HANDOFF_STORAGE_KEY)).toBeNull();
  });
});
