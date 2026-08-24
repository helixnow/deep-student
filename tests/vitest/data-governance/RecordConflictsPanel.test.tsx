/**
 * RecordConflictsPanel 单元测试
 *
 * 覆盖场景：
 * 1. 标题使用面向用户的「记录级冲突（N）」（sync:record_conflict_panel.title），
 *    N 为未解决冲突组总数，不再暴露分页实现细节
 * 2. 库名走 getDatabaseDisplayName（治理库渲染 i18n 显示名，未知库回退原始 id）
 * 3. detected_at 按 UTC 解析并本地化展示（SQLite datetime('now') 无时区标记）
 * 4. formatDetectedAt 纯函数行为（bare UTC / 带时区 / 非法输入回退）
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

const mockListRecordConflicts = vi.hoisted(() => vi.fn());
const mockCountRecordConflicts = vi.hoisted(() => vi.fn());
const mockResolveRecordConflict = vi.hoisted(() => vi.fn());
const mockPurgeResolvedConflicts = vi.hoisted(() => vi.fn());
const mockTranslate = vi.hoisted(() => vi.fn((key: string) => key));

vi.mock('@/api/dataGovernance', () => ({
  listRecordConflicts: mockListRecordConflicts,
  countRecordConflicts: mockCountRecordConflicts,
  resolveRecordConflict: mockResolveRecordConflict,
  purgeResolvedConflicts: mockPurgeResolvedConflicts,
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: mockTranslate }),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/utils/unifiedDialogs', () => ({
  unifiedConfirm: vi.fn(() => true),
}));

import RecordConflictsPanel, {
  formatDetectedAt,
} from '@/features/settings/components/data-governance/RecordConflictsPanel';
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

/** 与组件相同的本地化选项，保证断言与实现在任意时区/locale 下一致 */
function expectedLocalized(isoUtc: string): string {
  return new Date(isoUtc).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const defaultRows: RecordConflictRow[] = [
  makeRow({ id: 1, side: 'local', detected_at: '2026-08-23 10:00:00' }),
  makeRow({
    id: 2,
    side: 'cloud',
    data_json: '{"front":"cloud"}',
    detected_at: '2026-08-23T12:34:56Z',
  }),
  makeRow({
    id: 3,
    database_name: 'legacy_db',
    table_name: 'notes',
    record_id: 'note-9',
    side: 'local',
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  mockListRecordConflicts.mockResolvedValue(defaultRows);
  // 2 组已加载（mistakes/anki_cards/card-1 + legacy_db/notes/note-9），后端共 3 组未解决。
  // 形状与 RecordConflictCounts 一致（per_database + total_groups/total_rows）。
  mockCountRecordConflicts.mockResolvedValue({
    per_database: {
      mistakes: { groups: 2, rows: 3 },
      legacy_db: { groups: 1, rows: 1 },
    },
    total_groups: 3,
    total_rows: 4,
  });
});

// ============================================================================
// 标题
// ============================================================================

describe('RecordConflictsPanel 标题', () => {
  it('使用 sync:record_conflict_panel.title 并传入未解决总组数', async () => {
    render(<RecordConflictsPanel />);

    await waitFor(() => {
      expect(mockTranslate).toHaveBeenCalledWith(
        'sync:record_conflict_panel.title',
        { count: 3 },
      );
    });
    expect(screen.getByText('sync:record_conflict_panel.title')).toBeInTheDocument();
  });

  it('不再使用暴露分页细节的旧标题 key', async () => {
    render(<RecordConflictsPanel />);

    await waitFor(() => {
      expect(mockListRecordConflicts).toHaveBeenCalled();
    });
    const calledKeys = mockTranslate.mock.calls.map((call) => call[0]);
    expect(calledKeys).not.toContain('data:governance.conflict_panel_title');
  });

  it('计数接口报 0 组时以已加载组数兜底，标题不显示 0', async () => {
    // 例如计数与列表来自不同快照：count 尚未察觉新冲突时不能把标题压成 0
    mockCountRecordConflicts.mockResolvedValue({
      per_database: {},
      total_groups: 0,
      total_rows: 0,
    });
    render(<RecordConflictsPanel />);

    await waitFor(() => {
      expect(mockTranslate).toHaveBeenCalledWith(
        'sync:record_conflict_panel.title',
        { count: 2 },
      );
    });
  });
});

// ============================================================================
// 库名显示
// ============================================================================

describe('RecordConflictsPanel 库名', () => {
  it('治理库通过 getDatabaseDisplayName 渲染 i18n 显示名', async () => {
    render(<RecordConflictsPanel />);

    await waitFor(() => {
      expect(
        screen.getByText('data:governance.database_name.mistakes'),
      ).toBeInTheDocument();
    });
    // 原始 id 保留在 title 属性里便于排查
    expect(
      screen.getByText('data:governance.database_name.mistakes'),
    ).toHaveAttribute('title', 'mistakes');
  });

  it('未知库回退为原始 id', async () => {
    render(<RecordConflictsPanel />);

    await waitFor(() => {
      expect(screen.getByText('legacy_db')).toBeInTheDocument();
    });
  });
});

// ============================================================================
// detected_at 本地化
// ============================================================================

describe('RecordConflictsPanel detected_at 本地化', () => {
  it('SQLite 无时区时间按 UTC 解析并本地化渲染', async () => {
    render(<RecordConflictsPanel />);

    const expected = expectedLocalized('2026-08-23T10:00:00Z');
    await waitFor(() => {
      expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
    });
  });

  it('带时区标记的时间原样解析并本地化渲染', async () => {
    render(<RecordConflictsPanel />);

    const expected = expectedLocalized('2026-08-23T12:34:56Z');
    await waitFor(() => {
      expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
    });
  });
});

describe('formatDetectedAt', () => {
  it('无时区标记按 UTC 解析', () => {
    expect(formatDetectedAt('2026-08-23 10:00:00')).toBe(
      expectedLocalized('2026-08-23T10:00:00Z'),
    );
  });

  it('带 Z / 偏移量的时间不重复加时区', () => {
    expect(formatDetectedAt('2026-08-23T12:34:56Z')).toBe(
      expectedLocalized('2026-08-23T12:34:56Z'),
    );
    expect(formatDetectedAt('2026-08-23T20:34:56+08:00')).toBe(
      expectedLocalized('2026-08-23T12:34:56Z'),
    );
  });

  it('无法解析时原样返回', () => {
    expect(formatDetectedAt('not-a-date')).toBe('not-a-date');
    expect(formatDetectedAt('')).toBe('');
  });
});
