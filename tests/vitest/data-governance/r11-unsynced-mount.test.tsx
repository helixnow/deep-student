/**
 * [R11-unsynced-ui] SyncTab 挂载行锁定测试
 *
 * 锁定：未同步文件清单面板在 SyncTab 常驻挂载（不依赖云端已配置 / 有无冲突），
 * 且只拿到 refreshSignal，不接收任何同步写入口。SyncTab 本轮只允许加挂载
 * 行——双轨错误分类器（classifySyncError / classifySyncE2eeError）不动，
 * 由既有 r09-ux-sync-tab 测试继续钉住。
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// ============================================================================
// Mocks（与 r09-ux-sync-tab 相同的隔离策略）
// ============================================================================

const mockTranslate = vi.hoisted(() => vi.fn((key: string) => key));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockTranslate,
    i18n: { language: 'zh-CN', changeLanguage: () => Promise.resolve() },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

const autoSyncState = vi.hoisted(() => ({
  enabled: false,
  setEnabled: vi.fn(),
}));
vi.mock('@/stores/syncStatusStore', () => ({
  useAutoSyncStore: (selector: (s: typeof autoSyncState) => unknown) =>
    selector(autoSyncState),
  ensureAutoSyncSchedulerStarted: vi.fn(),
}));

vi.mock(
  '@/features/settings/components/data-governance/RecordConflictsPanel',
  () => ({
    RecordConflictsPanel: () => <div data-testid="record-conflicts-stub" />,
  }),
);
vi.mock(
  '@/features/settings/components/data-governance/SyncQuarantinePanel',
  () => ({
    SyncQuarantinePanel: () => <div data-testid="quarantine-stub" />,
  }),
);
vi.mock(
  '@/features/settings/components/data-governance/SyncIndicator',
  () => ({
    SyncIndicator: () => <div data-testid="sync-indicator-stub" />,
  }),
);
vi.mock('@/features/settings/components/CloudStorageSection', () => ({
  CloudStorageSection: () => <div data-testid="cloud-storage-stub" />,
}));
vi.mock('@/components/ui/app-menu', () => ({
  AppSelect: ({ value }: { value: string }) => (
    <div data-testid="app-select-stub">{value}</div>
  ),
}));
vi.mock('@/components/ui/DsDialog', () => ({
  DsAlertDialog: () => null,
}));

// 捕获挂载 props 的未同步面板桩
const unsyncedPanelProps = vi.hoisted(
  () => [] as Array<{ refreshSignal?: string | number }>,
);
vi.mock(
  '@/features/settings/components/data-governance/UnsyncedItemsPanel',
  () => ({
    UnsyncedItemsPanel: (props: {
      refreshSignal?: string | number;
    }) => {
      unsyncedPanelProps.push(props);
      return <div data-testid="unsynced-items-stub" />;
    },
  }),
);

import {
  SyncTab,
  type SyncTabProps,
} from '@/features/settings/components/data-governance/SyncTab';

function makeProps(overrides: Partial<SyncTabProps> = {}): SyncTabProps {
  return {
    syncStatus: null,
    conflicts: null,
    loading: false,
    onRefresh: vi.fn(),
    onDetectConflicts: vi.fn(),
    onResolveConflicts: vi.fn(),
    cloudSyncConfigured: false,
    cloudSyncSummary: null,
    syncRunning: false,
    syncProgress: null,
    syncStrategy: 'keep_latest',
    onSyncStrategyChange: vi.fn(),
    showCloudSettingsEditor: false,
    onToggleCloudSettingsEditor: vi.fn(),
    onSetCloudSettingsEditorOpen: vi.fn(),
    onCloudConfigChanged: vi.fn(),
    onRunSync: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  unsyncedPanelProps.length = 0;
});

describe('SyncTab 未同步清单面板挂载', () => {
  it('云端未配置、无冲突时面板也常驻挂载，并拿到 refreshSignal', () => {
    render(<SyncTab {...makeProps()} />);

    expect(screen.getByTestId('unsynced-items-stub')).toBeInTheDocument();
    expect(unsyncedPanelProps.length).toBeGreaterThan(0);
    // refreshSignal 与冲突面板同源（pending:synced 计数），同步后自动刷新
    expect(unsyncedPanelProps[0]).toEqual({ refreshSignal: '0:0' });
  });

  it('refreshSignal 跟随同步计数变化（同步完成后面板自动重查）', () => {
    const { rerender } = render(<SyncTab {...makeProps()} />);
    rerender(
      <SyncTab
        {...makeProps({
          syncStatus: {
            total_pending_changes: 3,
            total_synced_changes: 7,
            device_id: 'dev-1',
            databases: [],
          } as never,
        })}
      />,
    );
    const last = unsyncedPanelProps[unsyncedPanelProps.length - 1];
    expect(last.refreshSignal).toBe('3:7');
  });
});
