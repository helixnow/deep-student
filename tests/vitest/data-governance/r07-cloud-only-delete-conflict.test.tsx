/**
 * [R07-tests → R10-conflict-ui] 单侧 cloud-only DELETE 冲突在冲突面板中的可解决性锁定测试
 *
 * 背景：LWW 门败方 DELETE 只写一行 side='cloud' / data_json='null' 的冲突
 * （无 local 侧快照）。R06-del-resolve 让后端 resolve 命令可以消费这种形状
 * （缺 local 侧回退当前业务表行）；R10-conflict-ui 关闭 FINDINGS-R07 P1-1，
 * 前端「保留本地」对 cloud-only 组放开。本文件锁定新行为：
 *
 * 1. cloud-only 组必须正常渲染（local 侧显示"无"+ 人话说明这是云端单侧冲突，
 *    cloud 侧显示 null payload），不得因缺失 local 快照而崩溃或整组消失；
 * 2. 「采用云端」按钮可用，点击后以正确的 expectedConflictIds（仅 cloud 行 id）
 *    调用 resolve API；
 * 3. 「保留本地」按钮对 cloud-only 组**可点**（语义 = 驳回云端败方 DELETE/覆盖、
 *    保留本地胜方），点击先走 unifiedConfirm 两击确认——拒绝时绝不调用 resolve，
 *    确认后以仅含 cloud 行 id 的 expectedConflictIds 调用 keep_local；
 * 4. 批量「保留本地」**包含** cloud-only 组（不再按 locals.length 过滤）、
 *    批量「采用云端」同样包含它。
 *
 * 与 sync_r07_delete_resolve_lock_tests.rs（后端 e2e）互补。
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ============================================================================
// Mocks
// ============================================================================

const mockListRecordConflicts = vi.hoisted(() => vi.fn());
const mockCountRecordConflicts = vi.hoisted(() => vi.fn());
const mockResolveRecordConflict = vi.hoisted(() => vi.fn());
const mockPurgeResolvedConflicts = vi.hoisted(() => vi.fn());
const mockTranslate = vi.hoisted(() => vi.fn((key: string) => key));
const mockUnifiedConfirm = vi.hoisted(() => vi.fn(() => true));

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
  unifiedConfirm: mockUnifiedConfirm,
}));

import RecordConflictsPanel from '@/features/settings/components/data-governance/RecordConflictsPanel';
import type { RecordConflictRow } from '@/api/dataGovernance';

// ============================================================================
// 测试数据
// ============================================================================

/** LWW 门败方 DELETE 的真实形状：仅一行 side='cloud'、data_json='null' */
function cloudOnlyDeleteRow(overrides: Partial<RecordConflictRow> = {}): RecordConflictRow {
  return {
    id: 71,
    database_name: 'vfs',
    table_name: 'items',
    record_id: 'r07-one-sided-del',
    side: 'cloud',
    data_json: 'null',
    winning_device_id: null,
    losing_device_id: 'device-slow',
    detected_at: '2026-08-24 02:00:00',
    resolved_at: null,
    resolution: null,
    ...overrides,
  };
}

/** 对照组：常规双侧冲突（local + cloud 各一行） */
function twoSidedRows(): RecordConflictRow[] {
  return [
    cloudOnlyDeleteRow({
      id: 81,
      table_name: 'notes_meta',
      record_id: 'r07-two-sided',
      side: 'local',
      data_json: '{"title":"local"}',
    }),
    cloudOnlyDeleteRow({
      id: 82,
      table_name: 'notes_meta',
      record_id: 'r07-two-sided',
      side: 'cloud',
      data_json: '{"title":"cloud"}',
    }),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUnifiedConfirm.mockReturnValue(true);
  mockListRecordConflicts.mockResolvedValue([cloudOnlyDeleteRow()]);
  mockCountRecordConflicts.mockResolvedValue({ total_groups: 1 });
  mockResolveRecordConflict.mockResolvedValue(undefined);
  mockPurgeResolvedConflicts.mockResolvedValue(0);
});

// ============================================================================
// 渲染：cloud-only 组不得崩溃或消失，空状态要说人话
// ============================================================================

describe('cloud-only DELETE 冲突组渲染', () => {
  it('渲染冲突组：local 侧显示占位"无"+ 云端单侧冲突说明，cloud 侧显示 null payload', async () => {
    render(<RecordConflictsPanel />);

    await waitFor(() => {
      expect(screen.getByText('r07-one-sided-del')).toBeInTheDocument();
    });
    // local 侧无快照 → 显示 data:governance.none 占位
    expect(screen.getByText('data:governance.none')).toBeInTheDocument();
    // 人话空状态：说明这是云端单侧冲突、保留本地 = 驳回云端变更
    expect(screen.getByText('data:governance.conflict_cloud_only_hint')).toBeInTheDocument();
    // cloud 侧 data_json='null' 原样可见（tryFormatJson('null') === 'null'）
    expect(screen.getByText('null')).toBeInTheDocument();
  });

  it('标题计数把 cloud-only 组计为一个未解决组', async () => {
    render(<RecordConflictsPanel />);

    await waitFor(() => {
      expect(mockTranslate).toHaveBeenCalledWith(
        'sync:record_conflict_panel.title',
        { count: 1 },
      );
    });
  });
});

// ============================================================================
// 单组解决：采用云端与保留本地都可用（P1-1 关闭）
// ============================================================================

describe('cloud-only DELETE 冲突组解决', () => {
  it('「采用云端」可点击，并以仅含 cloud 行 id 的 expectedConflictIds 调用 resolve', async () => {
    const user = userEvent.setup();
    render(<RecordConflictsPanel />);
    await waitFor(() => {
      expect(screen.getByText('r07-one-sided-del')).toBeInTheDocument();
    });

    const useCloudButton = screen.getByRole('button', {
      name: 'data:governance.use_cloud_latest',
    });
    expect(useCloudButton).toBeEnabled();
    await user.click(useCloudButton);

    await waitFor(() => {
      expect(mockResolveRecordConflict).toHaveBeenCalledWith(
        'vfs',
        'items',
        'r07-one-sided-del',
        'keep_cloud',
        [71],
        undefined,
      );
    });
  });

  it('「保留本地」可点击：确认后以仅含 cloud 行 id 的 expectedConflictIds 调用 keep_local（驳回云端败方 DELETE）', async () => {
    const user = userEvent.setup();
    render(<RecordConflictsPanel />);
    await waitFor(() => {
      expect(screen.getByText('r07-one-sided-del')).toBeInTheDocument();
    });

    const keepLocalButton = screen.getByRole('button', {
      name: 'data:governance.keep_local',
    });
    expect(keepLocalButton).toBeEnabled();
    await user.click(keepLocalButton);

    // 危险语义必须先确认，不静默执行
    expect(mockUnifiedConfirm).toHaveBeenCalledTimes(1);
    expect(mockTranslate).toHaveBeenCalledWith(
      'data:governance.conflict_keep_local_cloud_only_confirm',
      { table: 'items', record: 'r07-one-sided-del' },
    );

    await waitFor(() => {
      expect(mockResolveRecordConflict).toHaveBeenCalledWith(
        'vfs',
        'items',
        'r07-one-sided-del',
        'keep_local',
        [71],
        undefined,
      );
    });
  });

  it('「保留本地」确认被拒绝时绝不调用 resolve', async () => {
    mockUnifiedConfirm.mockReturnValue(false);
    const user = userEvent.setup();
    render(<RecordConflictsPanel />);
    await waitFor(() => {
      expect(screen.getByText('r07-one-sided-del')).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole('button', { name: 'data:governance.keep_local' }),
    );

    expect(mockUnifiedConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(mockResolveRecordConflict).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// 批量解决：keep_local 与 keep_cloud 都包含 cloud-only 组
// ============================================================================

describe('cloud-only DELETE 冲突组的批量解决', () => {
  beforeEach(() => {
    mockListRecordConflicts.mockResolvedValue([
      cloudOnlyDeleteRow(),
      ...twoSidedRows(),
    ]);
    mockCountRecordConflicts.mockResolvedValue({ total_groups: 2 });
  });

  it('批量「保留本地」包含 cloud-only 组（P1-1：驳回云端败方 DELETE 批量可达）', async () => {
    const user = userEvent.setup();
    render(<RecordConflictsPanel />);
    await waitFor(() => {
      expect(screen.getByText('r07-one-sided-del')).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole('button', {
        name: 'data:governance.conflict_bulk_keep_local',
      }),
    );

    // 批量仍走一次确认对话框
    expect(mockUnifiedConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(mockResolveRecordConflict).toHaveBeenCalledTimes(2);
    });
    expect(mockResolveRecordConflict).toHaveBeenCalledWith(
      'vfs',
      'items',
      'r07-one-sided-del',
      'keep_local',
      [71],
      undefined,
    );
    expect(mockResolveRecordConflict).toHaveBeenCalledWith(
      'vfs',
      'notes_meta',
      'r07-two-sided',
      'keep_local',
      [81, 82],
      undefined,
    );
  });

  it('批量「保留本地」确认被拒绝时绝不执行', async () => {
    mockUnifiedConfirm.mockReturnValue(false);
    const user = userEvent.setup();
    render(<RecordConflictsPanel />);
    await waitFor(() => {
      expect(screen.getByText('r07-one-sided-del')).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole('button', {
        name: 'data:governance.conflict_bulk_keep_local',
      }),
    );

    expect(mockUnifiedConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(mockResolveRecordConflict).not.toHaveBeenCalled();
    });
  });

  it('批量「采用云端」包含 cloud-only 组（接受删除意图）', async () => {
    const user = userEvent.setup();
    render(<RecordConflictsPanel />);
    await waitFor(() => {
      expect(screen.getByText('r07-one-sided-del')).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole('button', {
        name: 'data:governance.conflict_bulk_use_cloud',
      }),
    );

    await waitFor(() => {
      expect(mockResolveRecordConflict).toHaveBeenCalledTimes(2);
    });
    expect(mockResolveRecordConflict).toHaveBeenCalledWith(
      'vfs',
      'items',
      'r07-one-sided-del',
      'keep_cloud',
      [71],
      undefined,
    );
    expect(mockResolveRecordConflict).toHaveBeenCalledWith(
      'vfs',
      'notes_meta',
      'r07-two-sided',
      'keep_cloud',
      [81, 82],
      undefined,
    );
  });
});
