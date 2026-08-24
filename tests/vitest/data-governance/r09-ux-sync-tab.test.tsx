/**
 * SyncTab UX 契约测试（R09-ux）
 *
 * 覆盖：
 * 1. 自动同步开关默认关闭且与 store 双向接线（不点开关绝不启用）；
 * 2. 库级冲突解决是危险操作：必须先弹确认框，确认才回调，取消不回调，
 *    use_cloud 用 danger 变体、keep_local 用 warning 变体；
 * 3. 明文遗留 / 加密密码缺失 / 密码错误三类引擎错误映射为人话
 *    （classifySyncError + sync:errors.* 键），未知错误原样透出；
 * 4. 同步失败面板的重试按钮仍接线；
 * 5. locale 契约：zh/en 的 autoSync 与 errors.* 键存在且写明关键语义。
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

// 稳定身份的 t：全局 mock 每次渲染新建 t，会让依赖 t 的 hook 依赖数组失效
const mockTranslate = vi.hoisted(() =>
  vi.fn((key: string) => key),
);
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
const mockEnsureScheduler = vi.hoisted(() => vi.fn());
vi.mock('@/stores/syncStatusStore', () => ({
  useAutoSyncStore: (selector: (s: typeof autoSyncState) => unknown) =>
    selector(autoSyncState),
  ensureAutoSyncSchedulerStarted: mockEnsureScheduler,
}));

// 子面板与云配置编辑器不在本测试范围内，用轻量桩隔离其数据请求
vi.mock(
  '@/features/settings/components/data-governance/RecordConflictsPanel',
  () => ({
    RecordConflictsPanel: () => <div data-testid="record-conflicts-stub" />,
    default: () => <div data-testid="record-conflicts-stub" />,
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

// 轻量 DsAlertDialog 桩：验证「打开才渲染 + 确认才回调 + 变体正确」的契约
vi.mock('@/components/ui/DsDialog', () => ({
  DsAlertDialog: ({
    open,
    title,
    description,
    confirmText,
    cancelText,
    confirmVariant,
    onConfirm,
    onOpenChange,
    children,
  }: any) =>
    open ? (
      <div role="alertdialog" data-confirm-variant={confirmVariant}>
        <div>{title}</div>
        <div>{description}</div>
        {children}
        <button type="button" onClick={onConfirm}>
          {confirmText}
        </button>
        <button type="button" onClick={() => onOpenChange?.(false)}>
          {cancelText}
        </button>
      </div>
    ) : null,
}));

import {
  SyncTab,
  classifySyncError,
  type SyncTabProps,
} from '@/features/settings/components/data-governance/SyncTab';
import type {
  ConflictDetectionResponse,
  SyncProgress,
} from '@/types/dataGovernance';

// ============================================================================
// 测试数据
// ============================================================================

// 引擎侧真实错误原文（来自 src-tauri data_governance/sync/mod.rs 与 crypto）
const LEGACY_PLAINTEXT_ERROR =
  '本机已启用同步加密，但云端 payload 缺少 DSBK 加密头（明文数据）。' +
  '为防止端到端加密被静默降级，已拒绝读取该数据。';
const MISSING_PASSWORD_ERROR =
  '云端文件级对象 assets/a.bin 是端到端加密的（DSBK 容器），但本机未配置加密密码。' +
  '请在云同步设置里填入正确的密码后重试。';
const WRONG_PASSWORD_ERROR =
  '解密 sync payload 失败（密码错误或数据损坏）: aead::Error';
const MANIFEST_PASSWORD_ERROR =
  '设备清单无法解密，已停止同步（请检查加密密码）: device-1 (aead::Error)';
const UNKNOWN_ERROR = '网络连接超时 (connection reset by peer)';

function makeProgress(error: string | null): SyncProgress {
  return {
    phase: 'failed',
    percent: 42,
    current: 3,
    total: 10,
    current_item: 'mistakes.db',
    speed_bytes_per_sec: null,
    eta_seconds: null,
    error,
  };
}

const conflictsWithData: ConflictDetectionResponse = {
  has_conflicts: true,
  needs_migration: false,
  database_conflicts: [
    {
      database_name: 'mistakes',
      conflict_type: 'data_conflict',
      local_version: 3,
      cloud_version: 4,
      local_schema_version: 1,
      cloud_schema_version: 1,
    },
  ],
  record_conflict_count: 2,
  local_manifest_json: null,
};

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

const zhSync = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/locales/zh-CN/sync.json'), 'utf-8'),
);
const enSync = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/locales/en-US/sync.json'), 'utf-8'),
);

beforeEach(() => {
  vi.clearAllMocks();
  autoSyncState.enabled = false;
});

// ============================================================================
// 自动同步默认关
// ============================================================================

describe('SyncTab 自动同步开关', () => {
  it('已配置云端时展示开关，默认（store enabled=false）为未开启', () => {
    render(
      <SyncTab
        {...makeProps({
          cloudSyncConfigured: true,
          cloudSyncSummary: { provider: 'webdav', root: 'deep-student-sync' },
        })}
      />,
    );

    const toggle = screen.getByRole('switch', { name: 'sync:autoSync.label' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('sync:autoSync.description')).toBeInTheDocument();
    // 进入面板只做幂等恢复调度，绝不隐式打开开关
    expect(mockEnsureScheduler).toHaveBeenCalled();
    expect(autoSyncState.setEnabled).not.toHaveBeenCalled();
  });

  it('点击开关走 store 的 setEnabled(true)，不直接触发同步回调', () => {
    const props = makeProps({
      cloudSyncConfigured: true,
      cloudSyncSummary: { provider: 'webdav', root: 'deep-student-sync' },
    });
    render(<SyncTab {...props} />);

    fireEvent.click(screen.getByRole('switch', { name: 'sync:autoSync.label' }));
    expect(autoSyncState.setEnabled).toHaveBeenCalledWith(true);
    expect(props.onRunSync).not.toHaveBeenCalled();
  });

  it('locale 契约：zh/en 文案写明默认关闭、启用行为与静默跳过前提', () => {
    expect(zhSync.autoSync.description).toContain('默认关闭');
    expect(zhSync.autoSync.description).toContain('开启后');
    expect(zhSync.autoSync.description).toContain('云端未配置');
    expect(zhSync.autoSync.description).toContain('缺少密码');
    expect(zhSync.autoSync.description).toContain('静默跳过');
    expect(enSync.autoSync.description).toMatch(/off by default/i);
    expect(enSync.autoSync.description).toMatch(/when enabled/i);
    expect(enSync.autoSync.description).toMatch(/cloud is not configured/i);
    expect(enSync.autoSync.description).toMatch(/password is missing/i);
    expect(enSync.autoSync.description).toMatch(/silently skipped/i);
  });
});

// ============================================================================
// 库级冲突解决危险确认
// ============================================================================

describe('SyncTab 库级冲突解决确认', () => {
  it('点击策略只打开确认框，确认后才执行且只执行一次', () => {
    const props = makeProps({ conflicts: conflictsWithData });
    render(<SyncTab {...props} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'data:governance.use_cloud' }),
    );
    expect(props.onResolveConflicts).not.toHaveBeenCalled();

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('sync:confirmConflictResolveTitle');
    expect(dialog).toHaveTextContent('sync:confirmConflictResolveDescription');
    // use_cloud 用云端覆盖本地，是最危险的策略 → danger 变体
    expect(dialog).toHaveAttribute('data-confirm-variant', 'danger');

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'common:actions.confirm' }),
    );
    expect(props.onResolveConflicts).toHaveBeenCalledTimes(1);
    expect(props.onResolveConflicts).toHaveBeenCalledWith('use_cloud');
    // 确认后弹窗关闭
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('keep_local 用 warning 变体；取消关闭弹窗且不回调', () => {
    const props = makeProps({ conflicts: conflictsWithData });
    render(<SyncTab {...props} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'data:governance.keep_local' }),
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('data-confirm-variant', 'warning');

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'common:actions.cancel' }),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(props.onResolveConflicts).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 引擎错误人话映射
// ============================================================================

describe('classifySyncError', () => {
  it('明文遗留拒收 → legacy_plaintext', () => {
    expect(classifySyncError(LEGACY_PLAINTEXT_ERROR)).toBe('legacy_plaintext');
  });

  it('本机未配置加密密码 → missing_password（先于错密码判断）', () => {
    expect(classifySyncError(MISSING_PASSWORD_ERROR)).toBe('missing_password');
    expect(
      classifySyncError(
        '检测到加密的 sync payload 但本端未配置加密密码。请在云同步设置里填入正确的密码后重试。',
      ),
    ).toBe('missing_password');
  });

  it('密码错误/数据损坏与清单解密失败 → wrong_password', () => {
    expect(classifySyncError(WRONG_PASSWORD_ERROR)).toBe('wrong_password');
    expect(classifySyncError(MANIFEST_PASSWORD_ERROR)).toBe('wrong_password');
    expect(
      classifySyncError('备份解密失败（密码错误或数据损坏）: aead::Error'),
    ).toBe('wrong_password');
  });

  it('未知错误返回 null（原样透出，不误分类）', () => {
    expect(classifySyncError(UNKNOWN_ERROR)).toBeNull();
    expect(classifySyncError('')).toBeNull();
  });
});

describe('SyncTab 错误面板人话展示', () => {
  const configured = {
    cloudSyncConfigured: true,
    cloudSyncSummary: { provider: 'webdav' as const, root: 'deep-student-sync' },
  };

  it('明文遗留错误显示人话键，原始错误保留为技术详情', () => {
    render(
      <SyncTab
        {...makeProps({
          ...configured,
          syncProgress: makeProgress(LEGACY_PLAINTEXT_ERROR),
        })}
      />,
    );

    expect(
      screen.getByText('sync:errors.legacyPlaintextRejected'),
    ).toBeInTheDocument();
    // 原始错误不丢：技术详情行里保留引擎原文
    expect(
      screen.getByText((text) => text.includes('缺少 DSBK 加密头')),
    ).toBeInTheDocument();
    expect(screen.getByText(/sync:errors\.technicalDetail/)).toBeInTheDocument();
  });

  it('错密码错误显示人话键，重试按钮仍接线', () => {
    const onRetrySync = vi.fn();
    render(
      <SyncTab
        {...makeProps({
          ...configured,
          syncProgress: makeProgress(WRONG_PASSWORD_ERROR),
          onRetrySync,
        })}
      />,
    );

    expect(
      screen.getByText('sync:errors.wrongEncryptionPassword'),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'common:actions.retry' }),
    );
    expect(onRetrySync).toHaveBeenCalledTimes(1);
  });

  it('未知错误原样透出，不显示技术详情行', () => {
    render(
      <SyncTab
        {...makeProps({
          ...configured,
          syncProgress: makeProgress(UNKNOWN_ERROR),
        })}
      />,
    );

    expect(screen.getByText(UNKNOWN_ERROR)).toBeInTheDocument();
    expect(
      screen.queryByText(/sync:errors\.technicalDetail/),
    ).not.toBeInTheDocument();
  });

  it('locale 契约：zh/en errors.* 键齐全且写明可操作的处理办法', () => {
    for (const locale of [zhSync, enSync]) {
      expect(String(locale.errors.legacyPlaintextRejected).length).toBeGreaterThan(0);
      expect(String(locale.errors.encryptionPasswordMissing).length).toBeGreaterThan(0);
      expect(String(locale.errors.wrongEncryptionPassword).length).toBeGreaterThan(0);
      expect(String(locale.errors.technicalDetail).length).toBeGreaterThan(0);
      // 人话不得再暴露 DSBK 内部术语
      expect(String(locale.errors.legacyPlaintextRejected)).not.toContain('DSBK');
      expect(String(locale.errors.wrongEncryptionPassword)).not.toContain('DSBK');
    }
    // zh：明文遗留给出「清密码→下载合并→清目录→重设密码→完整上传」路径
    expect(zhSync.errors.legacyPlaintextRejected).toContain('下载同步');
    expect(zhSync.errors.legacyPlaintextRejected).toContain('完整上传');
    // 错密码强调所有设备同一密码
    expect(zhSync.errors.wrongEncryptionPassword).toContain('同一个加密密码');
    expect(enSync.errors.wrongEncryptionPassword).toMatch(/same encryption password/i);
    expect(enSync.errors.legacyPlaintextRejected).toMatch(/download sync/i);
  });
});
