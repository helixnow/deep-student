/**
 * RecordConflictsPanel 冲突计数与批量危险操作测试（R09-ux）
 *
 * 覆盖：
 * 1. 冲突总数以 count API 的 total_groups 为准（与已加载组数解耦）；
 * 2. 「加载更多」按 total_groups 缺口出现，并以已加载组数作为 offset 续拉；
 * 3. 批量解决是危险操作：unifiedConfirm 拒绝时绝不执行，确认后逐组
 *    携带 expectedConflictIds 执行；
 * 4. 「清理已解决」按钮仍接线（purgeResolvedConflicts(30)）。
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

const mockListRecordConflicts = vi.hoisted(() => vi.fn());
const mockCountRecordConflicts = vi.hoisted(() => vi.fn());
const mockResolveRecordConflict = vi.hoisted(() => vi.fn());
const mockPurgeResolvedConflicts = vi.hoisted(() => vi.fn());
const mockUnifiedConfirm = vi.hoisted(() => vi.fn(() => true));
const mockTranslate = vi.hoisted(() => vi.fn((key: string) => key));

vi.mock('@/api/dataGovernance', () => ({
  listRecordConflicts: mockListRecordConflicts,
  countRecordConflicts: mockCountRecordConflicts,
  resolveRecordConflict: mockResolveRecordConflict,
  purgeResolvedConflicts: mockPurgeResolvedConflicts,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockTranslate,
    i18n: { language: 'zh-CN', changeLanguage: () => Promise.resolve() },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/utils/unifiedDialogs', () => ({
  unifiedConfirm: mockUnifiedConfirm,
}));

import RecordConflictsPanel from '@/features/settings/components/data-governance/RecordConflictsPanel';
import type { RecordConflictRow } from '@/api/dataGovernance';

// ============================================================================
// 测试数据
// ============================================================================

function makeRow(overrides: Partial<RecordConflictRow>): RecordConflictRow {
  return {
    id: 1,
    database_name: 'mistakes',
    table_name: 'anki_cards',
    record_id: 'card-1',
    side: 'local',
    data_json: '{"front":"local"}',
    winning_device_id: null,
    losing_device_id: null,
    detected_at: '2026-08-23 10:00:00',
    resolved_at: null,
    resolution: null,
    ...overrides,
  };
}

/** 一个组（local+cloud 各一行），后端共 3 组未解决 */
const singleGroupRows: RecordConflictRow[] = [
  makeRow({ id: 1, side: 'local' }),
  makeRow({ id: 2, side: 'cloud', data_json: '{"front":"cloud"}' }),
];

beforeEach(() => {
  vi.clearAllMocks();
  mockUnifiedConfirm.mockReturnValue(true);
  mockListRecordConflicts.mockResolvedValue(singleGroupRows);
  mockCountRecordConflicts.mockResolvedValue({
    per_database: { mistakes: { groups: 3, rows: 6 } },
    total_groups: 3,
    total_rows: 6,
  });
  mockResolveRecordConflict.mockResolvedValue(undefined);
  mockPurgeResolvedConflicts.mockResolvedValue(0);
});

// ============================================================================
// total_groups 口径
// ============================================================================

describe('RecordConflictsPanel total_groups 计数', () => {
  it('标题计数取 count API 的 total_groups，而非已加载行数/组数', async () => {
    render(<RecordConflictsPanel />);

    await waitFor(() => {
      expect(mockTranslate).toHaveBeenCalledWith(
        'sync:record_conflict_panel.title',
        { count: 3 },
      );
    });
  });

  it('已加载组数 < total_groups 时出现「加载更多」，offset 用已加载组数', async () => {
    render(<RecordConflictsPanel />);

    await waitFor(() => {
      expect(mockTranslate).toHaveBeenCalledWith(
        'data:governance.conflict_load_more',
        { shown: 1, total: 3 },
      );
    });

    mockListRecordConflicts.mockClear();
    mockListRecordConflicts.mockResolvedValue([
      makeRow({ id: 3, record_id: 'card-2', side: 'local' }),
    ]);
    fireEvent.click(
      screen.getByRole('button', { name: 'data:governance.conflict_load_more' }),
    );

    await waitFor(() => {
      expect(mockListRecordConflicts).toHaveBeenCalledWith(500, 1);
    });
    // 追加加载后按新数据重新分组渲染（2 组 < 3 组，按钮仍在）
    await waitFor(() => {
      expect(mockTranslate).toHaveBeenCalledWith(
        'data:governance.conflict_load_more',
        { shown: 2, total: 3 },
      );
    });
  });
});

// ============================================================================
// 批量解决危险确认
// ============================================================================

describe('RecordConflictsPanel 批量解决确认', () => {
  it('unifiedConfirm 拒绝时不执行任何解决', async () => {
    mockUnifiedConfirm.mockReturnValue(false);
    render(<RecordConflictsPanel />);

    const bulkButton = await screen.findByRole('button', {
      name: 'data:governance.conflict_bulk_use_cloud',
    });
    await waitFor(() => expect(bulkButton).toBeEnabled());
    fireEvent.click(bulkButton);

    expect(mockUnifiedConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(mockResolveRecordConflict).not.toHaveBeenCalled();
    });
  });

  it('确认后逐组执行并携带该组全部冲突行 id（乐观并发保护）', async () => {
    render(<RecordConflictsPanel />);

    const bulkButton = await screen.findByRole('button', {
      name: 'data:governance.conflict_bulk_use_cloud',
    });
    await waitFor(() => expect(bulkButton).toBeEnabled());
    fireEvent.click(bulkButton);

    await waitFor(() => {
      expect(mockResolveRecordConflict).toHaveBeenCalledTimes(1);
    });
    expect(mockResolveRecordConflict).toHaveBeenCalledWith(
      'mistakes',
      'anki_cards',
      'card-1',
      'keep_cloud',
      [1, 2],
      undefined,
    );
  });
});

// ============================================================================
// 清理已解决
// ============================================================================

describe('RecordConflictsPanel 清理已解决', () => {
  it('清理按钮调用 purgeResolvedConflicts(30) 并刷新', async () => {
    render(<RecordConflictsPanel />);

    const purgeButton = await screen.findByRole('button', {
      name: /data:governance\.conflict_purge_button/,
    });
    mockListRecordConflicts.mockClear();
    fireEvent.click(purgeButton);

    await waitFor(() => {
      expect(mockPurgeResolvedConflicts).toHaveBeenCalledWith(30);
    });
    await waitFor(() => {
      expect(mockListRecordConflicts).toHaveBeenCalled();
    });
  });
});
