/**
 * RecordConflictsPanel 字段级差异对比与渐进折叠原始 JSON 单元测试
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockListRecordConflicts = vi.hoisted(() => vi.fn());
const mockCountRecordConflicts = vi.hoisted(() => vi.fn());
const mockResolveRecordConflict = vi.hoisted(() => vi.fn());
const mockPurgeResolvedConflicts = vi.hoisted(() => vi.fn());
const mockListSyncSnapshotBatches = vi.hoisted(() => vi.fn());
const mockLanguage = vi.hoisted(() => ({ current: 'zh-CN' }));
const mockTranslate = vi.hoisted(() =>
  vi.fn((key: string, opts?: Record<string, unknown>) => {
    if (opts && 'field' in opts) return `${key}:${String(opts.field)}`;
    if (opts && 'count' in opts) return `${key}:${String(opts.count)}`;
    return key;
  }),
);

vi.mock('@/api/dataGovernance', () => ({
  listRecordConflicts: mockListRecordConflicts,
  countRecordConflicts: mockCountRecordConflicts,
  resolveRecordConflict: mockResolveRecordConflict,
  purgeResolvedConflicts: mockPurgeResolvedConflicts,
  listSyncSnapshotBatches: mockListSyncSnapshotBatches,
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: mockTranslate, i18n: { language: mockLanguage.current } }),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/utils/unifiedDialogs', () => ({
  unifiedConfirm: vi.fn(() => true),
}));

import RecordConflictsPanel, {
  buildConflictFieldDiffs,
  getConflictCopyLabelForLocale,
  parseConflictPlainObject,
} from '@/features/settings/components/data-governance/RecordConflictsPanel';
import type { RecordConflictRow } from '@/api/dataGovernance';

function makeConflictRow(overrides: Partial<RecordConflictRow>): RecordConflictRow {
  return {
    id: 1,
    database_name: 'mistakes',
    table_name: 'anki_cards',
    record_id: 'card-42',
    side: 'local',
    data_json: JSON.stringify({
      deck: 'Physics',
      front: 'Local Question',
      back: 'Local Answer',
      local_note: 'Only on laptop',
    }),
    winning_device_id: 'dev-local-1234',
    losing_device_id: null,
    detected_at: '2026-09-01 08:00:00',
    resolved_at: null,
    resolution: null,
    ...overrides,
  };
}

const twoSidedRows: RecordConflictRow[] = [
  makeConflictRow({ id: 10, side: 'local' }),
  makeConflictRow({
    id: 11,
    side: 'cloud',
    data_json: JSON.stringify({
      deck: 'Physics',
      front: 'Cloud Question',
      back: 'Cloud Answer',
      cloud_tag: 'exam-prep',
    }),
    winning_device_id: 'dev-cloud-5678',
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  mockLanguage.current = 'zh-CN';
  mockListRecordConflicts.mockResolvedValue(twoSidedRows);
  mockCountRecordConflicts.mockResolvedValue({
    per_database: { mistakes: { groups: 1, rows: 2 } },
    total_groups: 1,
    total_rows: 2,
  });
  mockResolveRecordConflict.mockResolvedValue(undefined);
  mockPurgeResolvedConflicts.mockResolvedValue(0);
  mockListSyncSnapshotBatches.mockResolvedValue([]);
});

describe('RecordConflictsPanel 字段级差异对比合并', () => {
  it('点击手动合并后默认展示字段差异对比表（差异字段置顶高亮），原始 JSON 折叠在 details 中', async () => {
    const user = userEvent.setup();
    render(<RecordConflictsPanel />);

    await waitFor(() => {
      expect(screen.getByText('card-42')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'data:governance.manual_merge' }));

    const diffTable = screen.getByTestId('conflict-field-diff-table');
    expect(diffTable).toBeInTheDocument();
    expect(diffTable.querySelector('table')).toBeNull();
    expect(
      within(diffTable).getByText('data:governance.merge_diff_count:4'),
    ).toBeInTheDocument();

    // 差异卡片标记 data-has-diff="true"，相同字段（deck）排在差异字段之后且 data-has-diff="false"
    const allRows = Array.from(diffTable.querySelectorAll('[data-testid^="conflict-diff-row-"]'));
    expect(allRows).toHaveLength(5);
    expect(allRows[0]).toHaveAttribute('data-has-diff', 'true');
    expect(allRows[allRows.length - 1]).toHaveAttribute('data-testid', 'conflict-diff-row-deck');
    expect(allRows[allRows.length - 1]).toHaveAttribute('data-has-diff', 'false');

    // 原始 JSON details 默认收起
    const rawDetails = screen.getByTestId('conflict-raw-json-details') as HTMLDetailsElement;
    expect(rawDetails.open).toBe(false);
  });

  it('支持按字段点选本机值/云端值，以及一键全部保留本机/全部采用云端，并同步提交写回', async () => {
    const user = userEvent.setup();
    render(<RecordConflictsPanel />);

    await waitFor(() => {
      expect(screen.getByText('card-42')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'data:governance.manual_merge' }));

    // 初始以 cloud 为基础：front 采用云端值，点选 front 的本机值与 local_note 的本机值
    const useLocalFrontBtn = screen.getByRole('button', {
      name: 'data:governance.merge_use_local_field:front',
    });
    const useCloudFrontBtn = screen.getByRole('button', {
      name: 'data:governance.merge_use_cloud_field:front',
    });
    expect(useCloudFrontBtn).toHaveAttribute('aria-pressed', 'true');
    expect(useLocalFrontBtn).toHaveAttribute('aria-pressed', 'false');

    await user.click(useLocalFrontBtn);
    expect(useLocalFrontBtn).toHaveAttribute('aria-pressed', 'true');
    expect(useCloudFrontBtn).toHaveAttribute('aria-pressed', 'false');

    const useLocalNoteBtn = screen.getByRole('button', {
      name: 'data:governance.merge_use_local_field:local_note',
    });
    await user.click(useLocalNoteBtn);

    // 验证底层 textarea JSON 实时同步了字段选择结果
    const textarea = screen.getByTestId('conflict-raw-json-textarea') as HTMLTextAreaElement;
    expect(JSON.parse(textarea.value)).toEqual({
      deck: 'Physics',
      front: 'Local Question',
      back: 'Cloud Answer',
      cloud_tag: 'exam-prep',
      local_note: 'Only on laptop',
    });

    // 测试一键「全部保留本机」与「全部采用云端」再混选一个字段后写回
    await user.click(
      screen.getByRole('button', { name: 'data:governance.merge_select_all_local' }),
    );
    expect(JSON.parse(textarea.value)).toEqual({
      deck: 'Physics',
      front: 'Local Question',
      back: 'Local Answer',
      local_note: 'Only on laptop',
    });

    await user.click(
      screen.getByRole('button', { name: 'data:governance.merge_select_all_cloud' }),
    );
    await user.click(
      screen.getByRole('button', { name: 'data:governance.merge_use_local_field:back' }),
    );

    await user.click(screen.getByRole('button', { name: 'data:governance.write_back' }));

    await waitFor(() => {
      expect(mockResolveRecordConflict).toHaveBeenCalledTimes(1);
    });
    const [db, table, recordId, resolution, expectedIds, mergedPayload] =
      mockResolveRecordConflict.mock.calls[0];
    expect(db).toBe('mistakes');
    expect(table).toBe('anki_cards');
    expect(recordId).toBe('card-42');
    expect(resolution).toBe('merged');
    expect(expectedIds).toEqual([10, 11]);
    expect(JSON.parse(mergedPayload as string)).toEqual({
      deck: 'Physics',
      front: 'Cloud Question',
      back: 'Local Answer',
      cloud_tag: 'exam-prep',
    });
  });

  it('可手动展开原始 JSON 编辑器并与字段对比表双向联动；非对象 JSON 自动展开回退', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<RecordConflictsPanel />);

    await waitFor(() => {
      expect(screen.getByText('card-42')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'data:governance.manual_merge' }));

    const rawDetails = screen.getByTestId('conflict-raw-json-details') as HTMLDetailsElement;
    expect(rawDetails.open).toBe(false);

    // 点击 summary 展开原始 JSON
    await user.click(screen.getByText('data:governance.merge_raw_json_summary'));
    expect(rawDetails.open).toBe(true);

    // 在原始 JSON 中写入自定义值，字段对比表显示自定义徽标
    const textarea = screen.getByTestId('conflict-raw-json-textarea');
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          deck: 'Physics',
          front: 'Manually Merged Question',
          back: 'Cloud Answer',
          cloud_tag: 'exam-prep',
        }),
      },
    });
    expect(screen.getByText('data:governance.merge_custom_badge')).toBeInTheDocument();

    unmount();

    // 非对象冲突（如 DELETE 产生的 null）：自动展开原始编辑器并展示回退提示
    mockListRecordConflicts.mockResolvedValue([
      makeConflictRow({
        id: 99,
        record_id: 'card-null',
        side: 'cloud',
        data_json: 'null',
      }),
    ]);
    render(<RecordConflictsPanel />);

    await waitFor(() => {
      expect(screen.getByText('card-null')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'data:governance.manual_merge' }));
    expect(screen.queryByTestId('conflict-field-diff-table')).not.toBeInTheDocument();
    expect(screen.getByTestId('conflict-raw-json-fallback-hint')).toBeInTheDocument();
    expect((screen.getByTestId('conflict-raw-json-details') as HTMLDetailsElement).open).toBe(
      true,
    );
  });

  it('纯函数 parseConflictPlainObject 与 buildConflictFieldDiffs 正确识别对象与差异', () => {
    expect(parseConflictPlainObject('null')).toBeNull();
    expect(parseConflictPlainObject('[1,2]')).toBeNull();
    expect(parseConflictPlainObject('{bad')).toBeNull();
    expect(parseConflictPlainObject('{"a":1}')).toEqual({ a: 1 });

    const diffs = buildConflictFieldDiffs(
      { same: 1, changed: 'a' },
      { same: 1, changed: 'b' },
      { same: 1, changed: 'a' },
    );
    expect(diffs.map((d) => d.key)).toEqual(['changed', 'same']);
    expect(diffs[0].selectedSource).toBe('local');
    expect(diffs[1].selectedSource).toBe('both');
  });

  it('Keep Both 按当前 UI 语言（en-US / zh-CN）透传本地化冲突副本标签，且操作按钮满足移动端 44px 触控目标', async () => {
    expect(getConflictCopyLabelForLocale('en-US')).toBe('Conflict copy');
    expect(getConflictCopyLabelForLocale('en')).toBe('Conflict copy');
    expect(getConflictCopyLabelForLocale('zh-CN')).toBe('本地冲突副本');
    expect(getConflictCopyLabelForLocale(undefined)).toBe('本地冲突副本');

    const user = userEvent.setup();

    // en-US 场景
    mockLanguage.current = 'en-US';
    const { unmount } = render(<RecordConflictsPanel />);
    await waitFor(() => {
      expect(screen.getByText('card-42')).toBeInTheDocument();
    });

    const actionsContainer = screen.getByTestId('conflict-card-actions');
    expect(actionsContainer.className).toContain('grid-cols-2');
    expect(actionsContainer.className).toContain('sm:flex');
    const actionButtons = within(actionsContainer).getAllByRole('button');
    expect(actionButtons).toHaveLength(4);
    for (const btn of actionButtons) {
      expect(btn.className).toContain('min-h-[44px]');
      expect(btn.className).toContain('sm:min-h-[36px]');
    }

    await user.click(screen.getByTestId('conflict-keep-both-button'));
    await waitFor(() => {
      expect(mockResolveRecordConflict).toHaveBeenCalledWith(
        'mistakes',
        'anki_cards',
        'card-42',
        'keep_both',
        [10, 11],
        undefined,
        'Conflict copy',
      );
    });
    unmount();

    // zh-CN 场景
    mockResolveRecordConflict.mockClear();
    mockLanguage.current = 'zh-CN';
    render(<RecordConflictsPanel />);
    await waitFor(() => {
      expect(screen.getByText('card-42')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('conflict-keep-both-button'));
    await waitFor(() => {
      expect(mockResolveRecordConflict).toHaveBeenCalledWith(
        'mistakes',
        'anki_cards',
        'card-42',
        'keep_both',
        [10, 11],
        undefined,
        '本地冲突副本',
      );
    });
  });
});
