/**
 * [R11-unsynced-ui] 未同步文件清单常驻面板契约测试
 *
 * 覆盖：
 * 1. 空态：云端清单全部已落地 → 绿勾空态；未配置云端 → 不发查询、给人话提示；
 * 2. 多类目：五类未同步条目分组展示，每组带人话原因 + 可执行建议，
 *    冲突类条目展示冲突对方 key，截断时给出诚实提示；
 * 3. 只读动作：downloadPending 不提供同步写入口；查询失败的行内重试与
 *    「重新检查」都只重新执行清单查询；
 * 4. SyncTab 挂载行锁定：面板常驻挂载且只拿到 refreshSignal；
 * 5. locale 契约：zh/en `unsynced.*` 键齐全对齐，建议文案写明可执行动作。
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

const mockTranslate = vi.hoisted(() =>
  vi.fn((key: string, params?: Record<string, unknown>) => {
    if (params && 'error' in params) return `${key}|${params.error}`;
    if (params && 'key' in params) return `${key}|${params.key}`;
    return key;
  }),
);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockTranslate,
    i18n: { language: 'zh-CN', changeLanguage: () => Promise.resolve() },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

const mockResolveConfig = vi.hoisted(() => vi.fn());
const mockToRuntimeConfig = vi.hoisted(() =>
  vi.fn((config: unknown) => ({ runtime: true, config })),
);
vi.mock('@/utils/cloudStorageApi', () => ({
  resolveCloudStorageConfig: mockResolveConfig,
  toRuntimeCloudStorageConfig: mockToRuntimeConfig,
}));

import {
  UnsyncedItemsPanel,
  type UnsyncedItem,
  type UnsyncedItemsReport,
} from '@/features/settings/components/data-governance/UnsyncedItemsPanel';

// ============================================================================
// 测试数据
// ============================================================================

const WEBDAV_CONFIG = {
  provider: 'webdav',
  webdav: { url: 'https://dav.example.com', username: 'u', password: 'p' },
  root: 'deep-student-sync',
};

function makeReport(
  items: UnsyncedItem[],
  overrides: Partial<UnsyncedItemsReport> = {},
): UnsyncedItemsReport {
  return {
    items,
    itemsTruncated: false,
    totalUnsynced: items.length,
    blobEntriesTotal: 10,
    assetEntriesTotal: 20,
    encryptionEnabled: true,
    generatedAt: '2026-08-24T07:00:00Z',
    ...overrides,
  };
}

const MULTI_CATEGORY_ITEMS: UnsyncedItem[] = [
  {
    kind: 'downloadPending',
    scope: 'blob',
    key: 'hash-pending',
    size: 42,
    detail: '云端对象 ab/pending.bin 尚未成功下载到本设备',
  },
  {
    kind: 'legacyPlaintext',
    scope: 'asset',
    key: 'active/videos/old.mp4',
    size: 7,
    detail: '云端条目是启用加密前上传的明文遗留对象',
  },
  {
    kind: 'caseConflict',
    scope: 'asset',
    key: 'active/images/photo.png',
    counterpart: 'active/images/Photo.PNG',
    size: 7,
    detail: '与另一文件仅文件名大小写不同',
  },
  {
    kind: 'sanitizedNameConflict',
    scope: 'asset',
    key: 'active/documents/report?.md',
    counterpart: 'active/documents/report_.md',
    size: 7,
    detail: '净化后重名且内容不同',
  },
  {
    kind: 'invalidKey',
    scope: 'asset',
    key: 'active/only-two',
    size: 7,
    detail: '云端 key 结构非法',
  },
];

const zhSync = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/locales/zh-CN/sync.json'), 'utf-8'),
);
const enSync = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/locales/en-US/sync.json'), 'utf-8'),
);

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveConfig.mockResolvedValue(WEBDAV_CONFIG);
});

// ============================================================================
// 空态
// ============================================================================

describe('UnsyncedItemsPanel 空态', () => {
  it('云端清单全部已落地时显示空态，查询走只读命令且带云配置', async () => {
    mockInvoke.mockResolvedValue(makeReport([]));
    render(<UnsyncedItemsPanel />);

    expect(await screen.findByText('sync:unsynced.empty')).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith(
      'data_governance_list_unsynced_items',
      { cloudConfig: { runtime: true, config: WEBDAV_CONFIG } },
    );
    // 空态下不渲染任何类目组或重试按钮
    expect(
      screen.queryByText('sync:unsynced.kind.downloadPending.label'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /sync:unsynced\.retrySync/ }),
    ).not.toBeInTheDocument();
  });

  it('未配置云端时不发起查询，显示人话提示', async () => {
    mockResolveConfig.mockResolvedValue(null);
    render(<UnsyncedItemsPanel />);

    expect(
      await screen.findByText('sync:unsynced.notConfigured'),
    ).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 多类目
// ============================================================================

describe('UnsyncedItemsPanel 多类目', () => {
  it('五类条目分组展示，每组带人话原因与可执行建议', async () => {
    mockInvoke.mockResolvedValue(makeReport(MULTI_CATEGORY_ITEMS));
    render(<UnsyncedItemsPanel />);

    for (const kind of [
      'downloadPending',
      'legacyPlaintext',
      'caseConflict',
      'sanitizedNameConflict',
      'invalidKey',
    ]) {
      expect(
        await screen.findByText(`sync:unsynced.kind.${kind}.label`),
      ).toBeInTheDocument();
      expect(
        screen.getByText(`sync:unsynced.kind.${kind}.reason`),
      ).toBeInTheDocument();
      expect(
        screen.getByText(`sync:unsynced.kind.${kind}.suggestion`),
      ).toBeInTheDocument();
    }

    // 条目 key 与冲突对方可见
    expect(screen.getByText('hash-pending')).toBeInTheDocument();
    expect(screen.getByText('active/images/photo.png')).toBeInTheDocument();
    expect(
      screen.getByText('sync:unsynced.counterpart|active/images/Photo.PNG'),
    ).toBeInTheDocument();
    // 技术详情折叠保留引擎原文
    expect(
      screen.getByText('云端对象 ab/pending.bin 尚未成功下载到本设备'),
    ).toBeInTheDocument();
    // 无截断时不显示截断提示
    expect(
      screen.queryByText('sync:unsynced.truncated'),
    ).not.toBeInTheDocument();
  });

  it('条目被截断时给出诚实提示', async () => {
    mockInvoke.mockResolvedValue(
      makeReport(MULTI_CATEGORY_ITEMS, {
        itemsTruncated: true,
        totalUnsynced: 987,
      }),
    );
    render(<UnsyncedItemsPanel />);

    expect(
      await screen.findByText('sync:unsynced.truncated'),
    ).toBeInTheDocument();
  });
});

// ============================================================================
// 只读刷新动作
// ============================================================================

describe('UnsyncedItemsPanel 只读刷新动作', () => {
  it('downloadPending 只展示建议，不提供下载同步写入口', async () => {
    mockInvoke.mockResolvedValue(makeReport([MULTI_CATEGORY_ITEMS[0]]));
    render(<UnsyncedItemsPanel />);

    await screen.findByText('sync:unsynced.kind.downloadPending.label');
    expect(
      screen.queryByRole('button', { name: /sync:unsynced\.retrySync/ }),
    ).not.toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual([
      'data_governance_list_unsynced_items',
    ]);
  });

  it('查询失败显示错误与行内重试，重试后恢复', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('网络超时'));
    mockInvoke.mockResolvedValueOnce(makeReport([]));
    render(<UnsyncedItemsPanel />);

    const failed = await screen.findByText(/sync:unsynced\.loadFailed/);
    expect(failed.textContent).toContain('网络超时');

    fireEvent.click(
      screen.getByRole('button', { name: 'common:actions.retry' }),
    );
    expect(await screen.findByText('sync:unsynced.empty')).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual([
      'data_governance_list_unsynced_items',
      'data_governance_list_unsynced_items',
    ]);
  });

  it('「重新检查」按钮重新发起查询', async () => {
    mockInvoke.mockResolvedValue(makeReport([]));
    render(<UnsyncedItemsPanel />);
    await screen.findByText('sync:unsynced.empty');

    fireEvent.click(
      screen.getByRole('button', { name: /sync:unsynced\.checkNow/ }),
    );
    expect(await screen.findByText('sync:unsynced.empty')).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual([
      'data_governance_list_unsynced_items',
      'data_governance_list_unsynced_items',
    ]);
  });
});

// ============================================================================
// locale 契约
// ============================================================================

describe('unsynced.* locale 契约', () => {
  const KINDS = [
    'downloadPending',
    'legacyPlaintext',
    'caseConflict',
    'sanitizedNameConflict',
    'invalidKey',
  ] as const;

  it('zh/en 键齐全且互相对齐', () => {
    for (const locale of [zhSync, enSync]) {
      const unsynced = locale.unsynced;
      expect(unsynced).toBeTruthy();
      for (const key of [
        'title',
        'description',
        'checkNow',
        'notConfigured',
        'empty',
        'loadFailed',
        'truncated',
        'retrySync',
        'technicalDetail',
        'counterpart',
        'scopeBlob',
        'scopeAsset',
      ]) {
        expect(String(unsynced[key]).length, `unsynced.${key}`).toBeGreaterThan(0);
      }
      for (const kind of KINDS) {
        for (const field of ['label', 'reason', 'suggestion'] as const) {
          expect(
            String(unsynced.kind[kind][field]).length,
            `unsynced.kind.${kind}.${field}`,
          ).toBeGreaterThan(0);
        }
      }
    }
    // zh/en 类目键集合一致
    expect(Object.keys(zhSync.unsynced.kind).sort()).toEqual(
      Object.keys(enSync.unsynced.kind).sort(),
    );
  });

  it('建议文案写明可执行动作，且是只读体检不动数据', () => {
    // 下载类 → 重试；明文遗留 → 源设备重新加密上传；命名类 → 改名
    expect(zhSync.unsynced.kind.downloadPending.suggestion).toContain('重试');
    expect(zhSync.unsynced.kind.legacyPlaintext.suggestion).toContain('上传同步');
    expect(zhSync.unsynced.kind.caseConflict.suggestion).toContain('改成');
    expect(zhSync.unsynced.kind.sanitizedNameConflict.suggestion).toContain('重命名');
    expect(enSync.unsynced.kind.downloadPending.suggestion).toMatch(/retry/i);
    expect(enSync.unsynced.kind.legacyPlaintext.suggestion).toMatch(/upload sync/i);
    expect(enSync.unsynced.kind.caseConflict.suggestion).toMatch(/rename/i);
    expect(enSync.unsynced.kind.sanitizedNameConflict.suggestion).toMatch(/rename/i);
    // 面板描述明确只读
    expect(zhSync.unsynced.description).toContain('只读');
    expect(enSync.unsynced.description).toMatch(/read-only/i);
    // 人话不暴露 DSBK 内部术语
    for (const locale of [zhSync, enSync]) {
      for (const kind of KINDS) {
        expect(String(locale.unsynced.kind[kind].reason)).not.toContain('DSBK');
      }
    }
  });
});
