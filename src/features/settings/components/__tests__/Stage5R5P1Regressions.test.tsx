import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import zhData from '@/locales/zh-CN/data.json';
import enData from '@/locales/en-US/data.json';
import zhSync from '@/locales/zh-CN/sync.json';
import enSync from '@/locales/en-US/sync.json';
import zhSettings from '@/locales/zh-CN/settings.json';
import enSettings from '@/locales/en-US/settings.json';

let currentLang: 'zh-CN' | 'en-US' = 'zh-CN';

function lookupKey(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, seg) => {
    if (acc && typeof acc === 'object' && seg in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[seg];
    }
    return undefined;
  }, obj);
}

function resolveLocale(ns: string): Record<string, unknown> {
  if (ns === 'data') return (currentLang === 'en-US' ? enData : zhData) as Record<string, unknown>;
  if (ns === 'sync') return (currentLang === 'en-US' ? enSync : zhSync) as Record<string, unknown>;
  if (ns === 'settings') return (currentLang === 'en-US' ? enSettings : zhSettings) as Record<string, unknown>;
  return {};
}

function mockTranslate(key: string, opts?: Record<string, unknown> | string): string {
  const options = typeof opts === 'string' ? { defaultValue: opts } : opts ?? {};
  const [ns, rest] = key.includes(':') ? key.split(':', 2) : ['sync', key];
  const raw = lookupKey(resolveLocale(ns), rest);
  let text = typeof raw === 'string' ? raw : (typeof options.defaultValue === 'string' ? options.defaultValue : key);
  for (const [k, v] of Object.entries(options)) {
    if (k === 'defaultValue') continue;
    text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
  }
  return text;
}

const translatorCache = new Map<string, (key: string, opts?: Record<string, unknown> | string) => string>();
function getStableTranslator(defaultNs?: string | string[]) {
  const ns = Array.isArray(defaultNs) ? defaultNs[0] : (defaultNs ?? 'sync');
  let fn = translatorCache.get(ns);
  if (!fn) {
    fn = (key: string, opts?: Record<string, unknown> | string) => {
      if (key.includes(':')) return mockTranslate(key, opts);
      return mockTranslate(`${ns}:${key}`, opts);
    };
    translatorCache.set(ns, fn);
  }
  return fn;
}

const stableI18n = {
  get language() {
    return currentLang;
  },
};

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: (defaultNs?: string | string[]) => ({
    t: getStableTranslator(defaultNs),
    i18n: stableI18n,
  }),
}));

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const mockCountRecordConflicts = vi.hoisted(() => vi.fn());
const mockListRecordConflicts = vi.hoisted(() => vi.fn());
const mockListQuarantine = vi.hoisted(() => vi.fn());
const mockListSnapshotBatches = vi.hoisted(() => vi.fn());

vi.mock('@/api/dataGovernance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/dataGovernance')>();
  return {
    ...actual,
    countRecordConflicts: (...args: unknown[]) => mockCountRecordConflicts(...args),
    listRecordConflicts: (...args: unknown[]) => mockListRecordConflicts(...args),
    listSyncSnapshotBatches: (...args: unknown[]) => mockListSnapshotBatches(...args),
    listQuarantine: (...args: unknown[]) => mockListQuarantine(...args),
    DataGovernanceApi: {
      ...actual.DataGovernanceApi,
      countRecordConflicts: (...args: unknown[]) => mockCountRecordConflicts(...args),
      listRecordConflicts: (...args: unknown[]) => mockListRecordConflicts(...args),
      listSyncSnapshotBatches: (...args: unknown[]) => mockListSnapshotBatches(...args),
      listQuarantine: (...args: unknown[]) => mockListQuarantine(...args),
    },
    getBackupConfig: vi.fn(async () => ({
      backupDirectory: null,
      autoBackupEnabled: false,
      autoBackupIntervalHours: 24,
      maxBackupCount: null,
      slimBackup: false,
    })),
    setBackupConfig: vi.fn(async () => undefined),
  };
});

const mockCreatePairingCode = vi.hoisted(() => vi.fn());
vi.mock('../../../../../host/plugins/sync/src/device-pairing', () => ({
  createPairingCode: (...args: unknown[]) => mockCreatePairingCode(...args),
  applyPairingCode: vi.fn(async () => ({
    summary: { cloudProvider: 'webdav', llmProviders: 1, includeSkills: true, includePlugins: true },
  })),
}));

import { DevicePairingSection } from '../DevicePairingSection';
import { SyncTab } from '../data-governance/SyncTab';
import { BackupTab, localizeBackupProgressMessage, localizeBackupStage } from '../data-governance/BackupTab';
import { useGlobalSyncStore } from '@/stores/syncStatusStore';

describe('Stage 5 Round 5 Vision QA P1 regressions (S5-02, S5-05, S5-17, S5-18)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentLang = 'zh-CN';
    useGlobalSyncStore.setState({
      isSyncing: false,
      source: null,
      progress: null,
      cancelRequested: false,
    });
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_setting') return null;
      if (cmd === 'data_governance_get_pending_breakdown') return { total_pending_changes: 0, databases: [] };
      return null;
    });
    mockCountRecordConflicts.mockResolvedValue({
      total_groups: 1,
      total_rows: 2,
      per_database: { vfs: { groups: 1, rows: 2 } },
    });
    mockListRecordConflicts.mockResolvedValue([
      {
        id: 101,
        database_name: 'vfs',
        table_name: 'notes',
        record_id: 'note-r5-1',
        side: 'local',
        data_json: JSON.stringify({ title: 'Local Note', content_md: 'Local body' }),
        winning_device_id: 'dev-local-1',
        detected_at: '2026-11-25 04:00:00',
      },
      {
        id: 102,
        database_name: 'vfs',
        table_name: 'notes',
        record_id: 'note-r5-1',
        side: 'cloud',
        data_json: JSON.stringify({ title: 'Cloud Note', content_md: 'Cloud body' }),
        winning_device_id: 'dev-cloud-2',
        detected_at: '2026-11-25 04:01:00',
      },
    ]);
    mockListQuarantine.mockResolvedValue([]);
    mockListSnapshotBatches.mockResolvedValue([]);
    mockCreatePairingCode.mockResolvedValue({
      pairingCode: `DSPAIR1:${'A'.repeat(240)}`,
      summary: { cloudProvider: 'webdav', llmProviders: 2, includeSkills: true, includePlugins: true },
    });
  });

  it('S5-02: Pairing snapshot push failure interpolates real error detail and never leaks literal {{error}}', async () => {
    useGlobalSyncStore.setState({
      isSyncing: false,
      source: null,
      progress: {
        phase: 'failed',
        percent: 0,
        current: 0,
        total: 0,
        current_item: '',
        speed_bytes_per_sec: 0,
        eta_seconds: null,
        error: 'WebDAV 401 Unauthorized',
      },
      cancelRequested: false,
    });
    const onRunSync = vi.fn(async () => false);
    render(<DevicePairingSection cloudConfigured onRunSync={onRunSync} />);

    fireEvent.click(screen.getByText('生成并立即推送本机最新快照'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('{{error}}');
    expect(alert.textContent).toContain('WebDAV 401 Unauthorized');
    expect(alert.textContent).not.toContain('配对码已生成');
  });

  it('S5-05: Conflict badge is a clickable button jumping to RecordConflictsPanel and reconciles conflict count summary', async () => {
    const scrollIntoViewMock = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock;

    render(
      <SyncTab
        syncStatus={{
          has_pending_changes: false,
          total_pending_changes: 0,
          total_synced_changes: 12,
          databases: [],
          last_sync_at: '2026-11-25T04:00:00Z',
          device_id: 'device-r5-test',
        }}
        conflicts={{
          has_conflicts: true,
          needs_migration: false,
          database_conflicts: [
            {
              database_name: 'vfs',
              conflict_type: 'version_mismatch',
              local_version: 2,
              cloud_version: 3,
              local_schema_version: 1,
              cloud_schema_version: 1,
            },
          ],
          // Simulate manifest-only detection returning 0 while __sync_conflicts has 1 group
          record_conflict_count: 0,
          local_manifest_json: '{}',
          cloud_manifest_json: '{}',
        }}
        loading={false}
        onRefresh={vi.fn()}
        onDetectConflicts={vi.fn()}
        onResolveConflicts={vi.fn()}
        cloudSyncConfigured
        cloudSyncSummary={{ provider: 'webdav', root: '/sync' }}
        syncRunning={false}
        syncProgress={null}
        syncStrategy="keep_latest"
        onSyncStrategyChange={vi.fn()}
        showCloudSettingsEditor={false}
        onToggleCloudSettingsEditor={vi.fn()}
        onSetCloudSettingsEditorOpen={vi.fn()}
        onCloudConfigChanged={vi.fn()}
        onRunSync={vi.fn()}
      />,
    );

    const jumpBtn = await screen.findByTestId('sync-conflicts-jump-button');
    expect(jumpBtn.tagName).toBe('BUTTON');
    expect(jumpBtn).toHaveTextContent('1 组冲突');

    // Conflict summary reconciles live record conflict count instead of showing 0
    await waitFor(() => {
      expect(screen.getByText('发现 1 个数据库冲突和 1 条记录冲突')).toBeInTheDocument();
    });

    const panel = screen.getByTestId('record-conflicts-panel');
    expect(panel).toHaveAttribute('id', 'record-conflicts-panel');

    fireEvent.click(jumpBtn);
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('S5-17: Generated DSPAIR1 code box expands without clipping and settings locales clearly surface Cloud & Sync', async () => {
    render(<DevicePairingSection cloudConfigured />);

    fireEvent.click(screen.getByText('一键随机 PIN 生成二维码'));

    const codeOutput = await screen.findByTestId('device-pairing-code-output');
    expect(codeOutput).toHaveValue(`DSPAIR1:${'A'.repeat(240)}`);
    expect(codeOutput.className).toContain('break-all');
    expect(codeOutput.className).toContain('whitespace-pre-wrap');
    expect(codeOutput.className).toContain('overflow-visible');
    expect(codeOutput.className).toContain('max-h-none');
    expect(Number(codeOutput.getAttribute('rows'))).toBeGreaterThanOrEqual(4);

    // Top-level settings tab label & quick shortcut locale contracts
    expect(zhSettings.tabs.data_governance).toContain('同步');
    expect(enSettings.tabs.data_governance).toContain('Sync');
    expect(zhSettings.quick_cloud_sync_title).toBeTruthy();
    expect(enSettings.quick_cloud_sync_title).toBeTruthy();
  });

  it('S5-18: en-US backup progress localizes raw stages and Chinese host messages with zero leaked CJK characters', () => {
    currentLang = 'en-US';
    const tEn = (key: string, opts?: Record<string, unknown>) => mockTranslate(key, opts);

    expect(localizeBackupStage('compress', tEn)).toBe('Compressing archive');
    expect(localizeBackupStage('checkpoint', tEn)).toBe('Checkpointing databases');
    expect(localizeBackupStage('Extracting ZIP', tEn)).toBe('Extracting ZIP');

    const localizedPreflight = localizeBackupProgressMessage(
      '正在生成便携清单并预检导出源...',
      tEn,
      'en-US',
    );
    expect(localizedPreflight).toBe('Generating portable manifest and preflighting export sources...');
    expect(localizedPreflight).not.toMatch(/[\u4e00-\u9fff]/);

    const localizedCompress = localizeBackupProgressMessage(
      '正在压缩: vfs.db (2/5)',
      tEn,
      'en-US',
    );
    expect(localizedCompress).toBe('Compressing: vfs.db (2/5)');
    expect(localizedCompress).not.toMatch(/[\u4e00-\u9fff]/);

    const localizedUnknownChinese = localizeBackupProgressMessage(
      '未知后端中文进度文案测试',
      tEn,
      'en-US',
    );
    expect(localizedUnknownChinese).toBe('Processing backup task...');
    expect(localizedUnknownChinese).not.toMatch(/[\u4e00-\u9fff]/);

    render(
      <BackupTab
        backups={[]}
        loading={false}
        onCreateLocalBackup={vi.fn()}
        onBackupAndExportZip={vi.fn()}
        onDeleteBackup={vi.fn()}
        onVerifyBackup={vi.fn()}
        onRestoreBackup={vi.fn()}
        onExportZip={vi.fn()}
        onImportZip={vi.fn()}
        isBackupRunning
        currentJobOperation="zip_export"
        backupProgress={{
          job_id: 'job-r5-en',
          kind: 'export',
          status: 'running',
          phase: 'compress',
          progress: 64,
          message: '正在生成便携清单并预检导出源...',
          processed_items: 2,
          total_items: 5,
          eta_seconds: 10,
          cancellable: true,
        }}
      />,
    );

    const progressPanel = screen.getByTestId('active-backup-progress-panel');
    expect(progressPanel.textContent).toContain('Compressing archive');
    expect(progressPanel.textContent).toContain('Generating portable manifest and preflighting export sources...');
    expect(progressPanel.textContent).not.toContain('compress');
    expect(progressPanel.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
