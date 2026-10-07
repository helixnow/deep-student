/**
 * 设置窗口「数据治理」的内存后端：本地备份列表（日期、大小）、自动备份策略、
 * 已配置但空闲的云存储（WebDAV）、健康检查、审计日志。
 * 真正的备份 / 恢复 / 同步 / 导入导出要读写本机文件，一律提示去桌面版。
 *
 * 只依赖演示数据模块，不碰 app 模块（见 ../../types.ts）。
 */
import { tr } from '../../../lang';
import type { DemoArgs } from '../../types';

type Rec = Record<string, unknown>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DATABASES = ['vfs', 'chat_v2', 'mistakes', 'llm_usage'];

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
function backupId(at: Date, rand: string): string {
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}_${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}_${rand}_${pad(at.getUTCMilliseconds(), 3)}`;
}

function makeBackup(agoMs: number, rand: string, sizeMb: number, partial = false): Rec {
  const at = new Date(Date.now() - agoMs);
  return {
    path: backupId(at, rand),
    created_at: at.toISOString(),
    size: Math.round(sizeMb * 1024 * 1024),
    backup_type: partial ? 'partial_overlay' : 'full',
    recovery_kind: partial ? 'partial_archive' : 'disaster_recovery',
    restorable: !partial,
    databases: partial ? ['chat_v2', 'vfs'] : DATABASES,
  };
}

function createState() {
  const now = Date.now();
  return {
    backups: [
      makeBackup(5 * HOUR, '3f9a1c2e', 486.3),
      makeBackup(29 * HOUR, 'b72d04a9', 481.7),
      makeBackup(53 * HOUR, '0c5e8f11', 474.2),
      makeBackup(3 * DAY + 2 * HOUR, '9d41ab76', 212.8, true),
      makeBackup(7 * DAY + 4 * HOUR, 'e2a7c950', 455.9),
    ],
    config: {
      backupDirectory: null as string | null,
      autoBackupEnabled: true,
      autoBackupIntervalHours: 24,
      maxBackupCount: 10 as number | null,
      slimBackup: false,
      backupTiers: ['core', 'important'],
    } as Rec,
    lastSync: new Date(now - 26 * HOUR).toISOString(),
    audit: [
      ['Backup', 'full_backup', 'Completed', 5 * HOUR, 41_200],
      ['Sync', 'cloud_upload', 'Completed', 26 * HOUR, 18_400],
      ['Backup', 'full_backup', 'Completed', 29 * HOUR, 39_800],
      ['Maintenance', 'health_check', 'Completed', 30 * HOUR, 640],
      ['Backup', 'full_backup', 'Completed', 53 * HOUR, 40_300],
      ['Backup', 'tiered_backup', 'Completed', 74 * HOUR, 12_900],
      ['Sync', 'cloud_upload', 'Failed', 4 * DAY, 30_000, '网络超时：WebDAV 服务器 30 秒内无响应'],
      ['Migration', 'chat_v2 v41 → v42', 'Completed', 6 * DAY, 1_120],
      ['Backup', 'full_backup', 'Completed', 7 * DAY + 4 * HOUR, 38_700],
      ['Restore', 'pre_restore_snapshot', 'Completed', 9 * DAY, 22_500],
    ].map(([op, target, status, ago, duration, error], i) => ({
      id: `audit-${i + 1}`,
      timestamp: new Date(now - (ago as number)).toISOString(),
      operation_type: op,
      target,
      status,
      duration_ms: duration,
      error_message: error ?? null,
    })),
  };
}

const state = createState();

const desktopOnly = (zh: string, en: string) =>
  new Error(tr(`${zh}要读写本机数据，请在桌面版中使用。`, `${en} works on your local data and is available in the desktop app.`));

function healthCheck(): Rec {
  return {
    overall_healthy: true,
    total_databases: DATABASES.length,
    initialized_count: DATABASES.length,
    uninitialized_count: 0,
    dependency_check_passed: true,
    dependency_error: null,
    databases: DATABASES.map((id, i) => ({
      id,
      is_healthy: true,
      dependencies_met: true,
      schema_version: [38, 42, 27, 9][i],
      target_version: [38, 42, 27, 9][i],
      pending_count: 0,
      issues: [],
    })),
    checked_at: new Date().toISOString(),
    pending_migrations_count: 0,
    has_pending_migrations: false,
    audit_log_healthy: true,
    audit_log_error: null,
    audit_log_error_at: null,
  };
}

function migrationStatus(): Rec {
  return {
    global_version: 116,
    all_healthy: true,
    databases: DATABASES.map((id, i) => ({
      id,
      current_version: [38, 42, 27, 9][i],
      target_version: [38, 42, 27, 9][i],
      is_initialized: true,
      last_migration_at: new Date(Date.now() - 6 * DAY).toISOString(),
      pending_count: 0,
      has_pending: false,
    })),
    pending_migrations_total: 0,
    has_pending_migrations: false,
    last_error: null,
  };
}

function syncStatus(): Rec {
  const pending = [12, 37, 4, 0];
  return {
    has_pending_changes: true,
    total_pending_changes: pending.reduce((a, b) => a + b, 0),
    total_synced_changes: 18_642,
    databases: DATABASES.map((id, i) => ({
      id,
      has_change_log: true,
      pending_changes: pending[i],
      synced_changes: [9_204, 7_311, 1_986, 141][i],
      last_sync_at: state.lastSync,
    })),
    last_sync_at: state.lastSync,
    device_id: 'demo-macbook-7f3a',
  };
}

export function handleDemoGovernance(cmd: string, args: DemoArgs): unknown {
  switch (cmd) {
    // 概览
    case 'data_governance_get_maintenance_status':
      return { is_in_maintenance_mode: false, blocked_components: [], component_health: null, component_issues: [] };
    case 'data_governance_get_migration_status':
      return migrationStatus();
    case 'data_governance_run_health_check':
      return healthCheck();
    // 审计
    case 'data_governance_get_audit_logs': {
      const op = args.operationType as string | undefined;
      const status = args.status as string | undefined;
      const rows = state.audit.filter((r) => (!op || r.operation_type === op) && (!status || r.status === status));
      const offset = Number(args.offset ?? 0);
      const limit = Number(args.limit ?? 50);
      return { logs: rows.slice(offset, offset + limit), total: rows.length };
    }
    case 'data_governance_cleanup_audit_logs':
      return 0;
    // 备份
    case 'get_backup_config':
      return { ...state.config };
    case 'set_backup_config':
      state.config = { ...state.config, ...((args.config as Rec | undefined) ?? {}) };
      return null;
    case 'get_auto_backup_status': {
      const last = state.backups[0]?.created_at as string | undefined;
      const hours = Number(state.config.autoBackupIntervalHours ?? 24);
      return {
        lastAttemptAt: last ?? null,
        lastSuccessAt: last ?? null,
        lastError: null,
        nextDueAt: last ? new Date(Date.parse(last) + hours * HOUR).toISOString() : null,
        lastJobId: null,
      };
    }
    case 'data_governance_get_backup_list':
      return state.backups.map((b) => ({ ...b }));
    case 'data_governance_delete_backup': {
      const id = String(args.backupId ?? args.backup_id ?? '');
      state.backups = state.backups.filter((b) => b.path !== id);
      return true;
    }
    case 'data_governance_verify_backup':
      return { is_valid: true, checksum_match: true, databases_verified: DATABASES.map((id) => ({ id, is_valid: true, error: null })), errors: [] };
    case 'data_governance_list_backup_jobs':
    case 'data_governance_list_resumable_jobs':
      return [];
    case 'data_governance_get_backup_job':
      return null;
    case 'data_governance_cleanup_persisted_jobs':
      return 0;
    case 'data_governance_check_disk_space_for_restore': {
      const b = state.backups.find((x) => x.path === args.backupId);
      const size = Number(b?.size ?? 0);
      return { has_enough_space: true, available_bytes: 182 * 1024 ** 3, required_bytes: Math.round(size * 2.2), backup_size: size };
    }
    case 'data_governance_run_backup':
    case 'data_governance_backup_tiered':
    case 'data_governance_backup_with_assets':
      throw desktopOnly('创建备份', 'Creating a backup');
    case 'data_governance_restore_backup':
    case 'data_governance_restore_with_assets':
      throw desktopOnly('恢复备份', 'Restoring a backup');
    case 'data_governance_export_zip':
    case 'data_governance_import_zip':
      throw desktopOnly('导入导出 ZIP', 'ZIP import/export');
    // 同步
    case 'data_governance_get_sync_status':
      return syncStatus();
    case 'data_governance_detect_conflicts':
      return { has_conflicts: false, needs_migration: false, database_conflicts: [], record_conflict_count: 0, local_manifest_json: null, cloud_manifest_json: null };
    case 'data_governance_list_record_conflicts':
    case 'data_governance_list_quarantine':
    case 'data_governance_list_sync_snapshot_batches':
      return [];
    case 'data_governance_count_record_conflicts':
      return { per_database: {}, total_groups: 0, total_rows: 0 };
    case 'data_governance_list_unsynced_items':
      return {
        items: [],
        itemsTruncated: false,
        totalUnsynced: 0,
        blobEntriesTotal: 1_284,
        assetEntriesTotal: 356,
        encryptionEnabled: true,
        generatedAt: new Date().toISOString(),
      };
    case 'data_governance_run_sync':
    case 'data_governance_run_sync_with_progress':
    case 'data_governance_export_sync_data':
    case 'data_governance_import_sync_data':
    case 'data_governance_repo_check':
    case 'data_governance_detect_prune_gap':
      throw desktopOnly('云同步', 'Cloud sync');
    case 'data_governance_cancel_sync':
      return false;
    // 云存储
    case 'cloud_config_ssot_get':
      return {
        configured: true,
        provider: 'webdav',
        root: 'deep-student',
        config: { provider: 'webdav', webdav: { endpoint: 'https://dav.example.com/remote.php/dav/files/student', username: 'student' }, root: 'deep-student' },
      };
    case 'secure_get_cloud_credentials':
      return { webdavPasswordConfigured: true, s3SecretAccessKeyConfigured: false, ftpPasswordConfigured: false, encryptionPasswordConfigured: true };
    case 'cloud_sync_get_device_id':
      return 'demo-macbook-7f3a';
    case 'cloud_storage_is_s3_enabled':
      return true;
    case 'cloud_config_test_connection_draft':
    case 'cloud_config_publish':
    case 'cloud_storage_check_connection':
    case 'cloud_storage_test_connection':
      throw desktopOnly('连接云存储', 'Connecting to cloud storage');
    default:
      return undefined;
  }
}
