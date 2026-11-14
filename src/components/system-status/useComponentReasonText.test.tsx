import React from 'react';
import { createInstance, type i18n as I18n } from 'i18next';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import zhCommon from '@/locales/zh-CN/common.json';
import zhData from '@/locales/zh-CN/data.json';
import enCommon from '@/locales/en-US/common.json';
import enData from '@/locales/en-US/data.json';
import { useSystemStatusStore } from '@/stores/systemStatusStore';

import { parseComponentReason } from './componentReason';
import { FeatureUnavailablePanel } from './FeatureUnavailablePanel';
import { formatComponentReason, type ComponentReasonTranslate } from './useComponentReasonText';

vi.mock('@/utils/platform', () => ({ isMobilePlatform: () => false }));
vi.mock('@/components/WindowControls', () => ({ WindowControls: () => null }));
vi.mock('@/features/data-recovery/dataRecoveryApi', () => ({
  exportStartupRecoveryReport: vi.fn(async () => null),
  retryRecoveryStartup: vi.fn(),
}));

import { ComponentRecoveryShell } from '@/features/data-recovery/ComponentRecoveryShell';

const ID = 'RF-W09-recovery-reason-localized';

async function makeI18n(lng: 'zh-CN' | 'en-US'): Promise<I18n> {
  const instance = createInstance();
  await instance.init({
    lng,
    resources: { 'zh-CN': { common: zhCommon, data: zhData }, 'en-US': { common: enCommon, data: enData } },
    ns: ['common', 'data'],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
  });
  return instance;
}

function translator(instance: I18n): ComponentReasonTranslate {
  return (key, values) => instance.t(`data:recovery.component_reason.${key}`, values);
}

const VFS_PATH = '/Users/x/Library/Application Support/deep-student/slots/slotA/databases/vfs.db';
const KEPT = `Database 'vfs' migration failed: Database error: file is not a database. No snapshot was taken before this migration run, so nothing was restored; the database file was kept in place at ${VFS_PATH} (not deleted or overwritten). No earlier snapshot contains this database.`;

/** Rust（Tauri）与 Host 实际产出的原因句子。 */
const BACKEND_REASONS = [
  "Skipped because dependency 'vfs' is blocked",
  "Skipped because dependency 'vfs' has an unresolved restore failure",
  "Database 'vfs' migration failed: Database error: file is not a database. Restored this database from the startup snapshot.",
  "Database 'vfs' migration failed: boom. Restored this database from the startup snapshot migration_core_backups/startup_20261107T010203.",
  "Database 'vfs' migration failed: boom. The startup snapshot migration_core_backups/startup_1 shows this database did not exist before the migration; removed the file created by the failed migration.",
  KEPT,
  `Database 'vfs' migration failed: boom. No snapshot was taken before this migration run, so nothing was restored; the database file was kept in place at ${VFS_PATH} (not deleted or overwritten). The newest earlier snapshot containing it, migration_core_backups/startup_0, was not applied automatically.`,
  "Database 'chat_v2' migration failed: Migration error: v3. Restoring this database also failed: IO error: disk full",
  "Database 'vfs' remains blocked: migration failed (Database error: x); restoring the trusted startup snapshot failed again (Database error: No trusted snapshot is recorded for this failure; the database file was kept in place at /d/vfs.db (not deleted or overwritten))",
  "Database 'vfs' migration failed: boom. Something new.",
  'Schema aggregation failed: Database error: vfs: boom',
  'Schema version read failed: boom',
  'Migration history read failed: boom',
];

const RUST_CHINESE_REASONS = [
  '迁移失败后已恢复旧版数据结构: Migration error: Migration failed but recovered from backup: boom (restored 1 databases)',
  '启动迁移无法建立安全状态: Migration error: boom',
  'Chat V2 数据库初始化失败: boom',
  'LLM Usage 数据库初始化失败: boom',
  '审计日志初始化失败: boom',
];

describe('component reason text', () => {
  it(`${ID}: en-US reproduces every backend sentence verbatim`, async () => {
    const tr = translator(await makeI18n('en-US'));
    for (const reason of BACKEND_REASONS) {
      expect(formatComponentReason(parseComponentReason(reason), tr)).toBe(reason);
    }
  });

  it(`${ID}: zh-CN localises the sentence frame and keeps the low-level error, path and snapshot verbatim`, async () => {
    const tr = translator(await makeI18n('zh-CN'));
    // Rust 原样：中文界面里整句英文
    expect(formatComponentReason(parseComponentReason(KEPT), tr)).toBe(
      `数据库 vfs 升级失败：Database error: file is not a database。本次升级前没有建立快照，因此没有执行恢复；数据库文件保留在原位置 ${VFS_PATH}，没有被删除或覆盖。更早的快照里也没有这个数据库。`,
    );
    expect(formatComponentReason(parseComponentReason("Skipped because dependency 'vfs' is blocked"), tr)).toBe(
      '依赖的数据组件 vfs 已暂停，本组件跳过了升级。',
    );
    expect(
      formatComponentReason(parseComponentReason("Database 'vfs' migration failed: boom. Restored this database from the startup snapshot."), tr),
    ).toBe('数据库 vfs 升级失败：boom。已从启动快照恢复该数据库。');
    for (const reason of BACKEND_REASONS.filter((r) => !r.endsWith('Something new.'))) {
      const text = formatComponentReason(parseComponentReason(reason), tr);
      expect(text, reason).not.toMatch(/Skipped because|migration failed|Restored this|No snapshot was taken|remains blocked|read failed|aggregation failed/);
    }
  });

  it(`${ID}: zh-CN shows the Chinese reasons Rust already produced exactly as Tauri did`, async () => {
    const tr = translator(await makeI18n('zh-CN'));
    for (const reason of RUST_CHINESE_REASONS) {
      expect(formatComponentReason(parseComponentReason(reason), tr)).toBe(reason);
    }
  });

  it(`${ID}: unknown sentences are shown unchanged in both languages`, async () => {
    for (const lng of ['zh-CN', 'en-US'] as const) {
      const tr = translator(await makeI18n(lng));
      expect(formatComponentReason(parseComponentReason('Host plugin dstu.anki crashed'), tr)).toBe('Host plugin dstu.anki crashed');
    }
  });
});

// 测试环境的 react-i18next 是读 zh-CN 语言包的替身（vitest.config.ts alias）。
describe('screens that show component reasons', () => {
  it(`${ID}: the core recovery screen shows localised reasons and keeps the unknown-reason fallback`, () => {
    render(
      <ComponentRecoveryShell
        components={[
          { component: 'vfs', status: 'blocked', reason: KEPT, dependency: null },
          { component: 'mistakes', status: 'blocked', reason: "Skipped because dependency 'vfs' is blocked", dependency: 'vfs' },
          { component: 'chat_v2', status: 'blocked', reason: null, dependency: null },
        ]}
      />,
    );
    expect(screen.getByText(/^数据库 vfs 升级失败：Database error: file is not a database。本次升级前没有建立快照/)).toBeInTheDocument();
    expect(screen.getByText('依赖的数据组件 vfs 已暂停，本组件跳过了升级。')).toBeInTheDocument();
    expect(screen.getByText(zhData.recovery.component_unknown_reason)).toBeInTheDocument();
    expect(screen.queryByText(/Skipped because|migration failed/)).toBeNull();
  });

  it(`${ID}: the feature-unavailable panel shows the localised reason`, () => {
    useSystemStatusStore.getState().setComponentHealth([
      { component: 'chat_v2', status: 'blocked', reason: "Skipped because dependency 'vfs' is blocked", dependency: 'vfs' },
    ]);
    render(<FeatureUnavailablePanel component="chat_v2" title="Chat" />);
    expect(screen.getByText('依赖的数据组件 vfs 已暂停，本组件跳过了升级。')).toBeInTheDocument();
    useSystemStatusStore.getState().setComponentHealth([]);
  });
});
