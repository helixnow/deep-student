/**
 * 数据治理系统 API 契约测试
 *
 * 验证前端 API 层调用 Tauri invoke 时：
 *   1. 传递正确的命令名称
 *   2. 参数格式正确（camelCase → snake_case 转换等）
 *   3. 返回值符合约定的类型结构
 *   4. 边缘情况处理（空响应、null 字段、可选字段缺失）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Mock @tauri-apps/api/core ──
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// ── Mock @tauri-apps/api/event（部分 API 依赖 listen） ──
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

import {
  runBackup,
  restoreBackup,
  getBackupList,
  deleteBackup,
  verifyBackup,
  autoVerifyLatestBackup,
  runHealthCheck,
  getMigrationStatus,
  getSchemaRegistry,
  getDatabaseStatus,
  getAuditLogs,
  cleanupAuditLogs,
  getBackupConfig,
  setBackupConfig,
  cancelBackup,
  getBackupJob,
  listBackupJobs,
  resumeBackupJob,
  listResumableJobs,
  cleanupPersistedJobs,
  backupTiered,
  backupAndExportZip,
  exportZip,
  importZip,
  scanAssets,
  getAssetTypes,
  restoreWithAssets,
  verifyBackupWithAssets,
  checkChatMigrationStatus,
  migrateLegacyChat,
  rollbackChatMigration,
  getMediaCacheStats,
  clearMediaCache,
  checkDiskSpaceForRestore,
  getMaintenanceStatus,
} from '@/api/dataGovernance';

import type {
  BackupInfoResponse,
  HealthCheckResponse,
  DatabaseHealthStatus,
  MigrationStatusResponse,
  AuditLogResponse,
  SchemaRegistryResponse,
  DatabaseDetailResponse,
  BackupVerifyResponse,
  AutoVerifyResponse,
} from '@/types/dataGovernance';

import type {
  BackupJobStartResponse,
  BackupJobSummary,
  BackupConfig,
  DiskSpaceCheckResponse,
  ChatMigrationCheckResult,
  ChatMigrationReport,
  MediaCacheStats,
  ClearMediaCacheResult,
} from '@/api/dataGovernance';

// ═══════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════

beforeEach(() => {
  mockInvoke.mockReset();
});

/** 断言 invoke 只被调用一次并返回命令名+参数 */
function expectSingleInvoke(command: string, expectedArgs?: Record<string, unknown>) {
  expect(mockInvoke).toHaveBeenCalledTimes(1);
  expect(mockInvoke.mock.calls[0]![0]).toBe(command);
  if (expectedArgs !== undefined) {
    expect(mockInvoke.mock.calls[0]![1]).toEqual(expectedArgs);
  }
}

// ═══════════════════════════════════════════════════════════
//  1. runBackup
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi.runBackup() contract', () => {
  const mockResponse: BackupJobStartResponse = {
    job_id: 'job-abc-123',
    kind: 'export',
    status: 'queued',
    message: 'Backup job queued',
  };

  it('calls invoke with correct command name and snake_case params', async () => {
    mockInvoke.mockResolvedValue(mockResponse);
    await runBackup('full', undefined, true, ['images', 'documents']);

    expectSingleInvoke('data_governance_run_backup', {
      backup_type: 'full',
      base_version: undefined,
      include_assets: true,
      asset_types: ['images', 'documents'],
    });
  });

  it('passes undefined for omitted optional parameters', async () => {
    mockInvoke.mockResolvedValue(mockResponse);
    await runBackup();

    expectSingleInvoke('data_governance_run_backup', {
      backup_type: undefined,
      base_version: undefined,
      include_assets: undefined,
      asset_types: undefined,
    });
  });

  it('returns BackupJobStartResponse with all required fields', async () => {
    mockInvoke.mockResolvedValue(mockResponse);
    const result = await runBackup('full');

    expect(result).toHaveProperty('job_id');
    expect(result).toHaveProperty('kind');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('message');
    expect(typeof result.job_id).toBe('string');
    expect(typeof result.kind).toBe('string');
  });

  it('passes incremental backup params correctly', async () => {
    mockInvoke.mockResolvedValue(mockResponse);
    await runBackup('incremental', 'v1.0.0');

    expectSingleInvoke('data_governance_run_backup', {
      backup_type: 'incremental',
      base_version: 'v1.0.0',
      include_assets: undefined,
      asset_types: undefined,
    });
  });
});

// ═══════════════════════════════════════════════════════════
//  2. restoreBackup
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi.restoreBackup() contract', () => {
  const mockResponse: BackupJobStartResponse = {
    job_id: 'restore-job-1',
    kind: 'import',
    status: 'queued',
    message: 'Restore job queued',
  };

  it('calls invoke with correct command and backupId → snake_case params', async () => {
    mockInvoke.mockResolvedValue(mockResponse);
    await restoreBackup('backup-2026-02-07');

    expectSingleInvoke('data_governance_restore_backup', {
      backup_id: 'backup-2026-02-07',
      restore_assets: undefined,
    });
  });

  it('passes restoreAssets option correctly', async () => {
    mockInvoke.mockResolvedValue(mockResponse);
    await restoreBackup('backup-2026-02-07', true);

    expectSingleInvoke('data_governance_restore_backup', {
      backup_id: 'backup-2026-02-07',
      restore_assets: true,
    });
  });

  it('returns BackupJobStartResponse format', async () => {
    mockInvoke.mockResolvedValue(mockResponse);
    const result = await restoreBackup('backup-id');

    expect(result.job_id).toBe('restore-job-1');
    expect(result.kind).toBe('import');
    expect(result.status).toBe('queued');
    expect(result.message).toBe('Restore job queued');
  });
});

// ═══════════════════════════════════════════════════════════
//  3. getBackupList
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi.getBackupList() contract', () => {
  const mockBackupList: BackupInfoResponse[] = [
    {
      path: '/backups/2026-02-07_full',
      created_at: '2026-02-07T10:00:00Z',
      size: 1048576,
      backup_type: 'full',
      databases: ['vfs', 'chat_v2', 'mistakes'],
    },
    {
      path: '/backups/2026-02-06_incremental',
      created_at: '2026-02-06T10:00:00Z',
      size: 524288,
      backup_type: 'incremental',
      databases: ['chat_v2'],
    },
  ];

  it('calls invoke without params', async () => {
    mockInvoke.mockResolvedValue(mockBackupList);
    await getBackupList();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0]![0]).toBe('data_governance_get_backup_list');
    expect(mockInvoke.mock.calls[0]![1]).toBeUndefined();
  });

  it('returns BackupInfoResponse[] with required fields', async () => {
    mockInvoke.mockResolvedValue(mockBackupList);
    const result = await getBackupList();

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);

    for (const backup of result) {
      expect(backup).toHaveProperty('path');
      expect(backup).toHaveProperty('size');
      expect(backup).toHaveProperty('databases');
      expect(backup).toHaveProperty('created_at');
      expect(backup).toHaveProperty('backup_type');
      expect(typeof backup.path).toBe('string');
      expect(typeof backup.size).toBe('number');
      expect(Array.isArray(backup.databases)).toBe(true);
      expect(['full', 'incremental']).toContain(backup.backup_type);
    }
  });

  it('handles empty backup list', async () => {
    mockInvoke.mockResolvedValue([]);
    const result = await getBackupList();

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
//  4. runHealthCheck
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi.runHealthCheck() contract', () => {
  const mockHealthy: HealthCheckResponse = {
    overall_healthy: true,
    total_databases: 4,
    initialized_count: 4,
    uninitialized_count: 0,
    dependency_check_passed: true,
    dependency_error: null,
    databases: [
      {
        id: 'vfs',
        is_healthy: true,
        dependencies_met: true,
        schema_version: 5,
        target_version: 5,
        pending_count: 0,
        issues: [],
      },
      {
        id: 'chat_v2',
        is_healthy: true,
        dependencies_met: true,
        schema_version: 3,
        target_version: 3,
        pending_count: 0,
        issues: [],
      },
    ],
    checked_at: '2026-02-07T12:00:00Z',
    pending_migrations_count: 0,
    has_pending_migrations: false,
    audit_log_healthy: true,
    audit_log_error: null,
    audit_log_error_at: null,
  };

  it('calls invoke without params', async () => {
    mockInvoke.mockResolvedValue(mockHealthy);
    await runHealthCheck();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0]![0]).toBe('data_governance_run_health_check');
    expect(mockInvoke.mock.calls[0]![1]).toBeUndefined();
  });

  it('returns HealthCheckResponse with databases array', async () => {
    mockInvoke.mockResolvedValue(mockHealthy);
    const result = await runHealthCheck();

    expect(result).toHaveProperty('overall_healthy');
    expect(result).toHaveProperty('total_databases');
    expect(result).toHaveProperty('databases');
    expect(Array.isArray(result.databases)).toBe(true);

    const db: DatabaseHealthStatus = result.databases[0]!;
    expect(db).toHaveProperty('id');
    expect(db).toHaveProperty('is_healthy');
    expect(db).toHaveProperty('dependencies_met');
    expect(db).toHaveProperty('schema_version');
    expect(db).toHaveProperty('target_version');
    expect(db).toHaveProperty('pending_count');
    expect(db).toHaveProperty('issues');
    expect(typeof db.id).toBe('string');
    expect(typeof db.is_healthy).toBe('boolean');
    expect(typeof db.schema_version).toBe('number');
  });

  it('returns unhealthy status with issues', async () => {
    const unhealthy: HealthCheckResponse = {
      ...mockHealthy,
      overall_healthy: false,
      databases: [
        {
          id: 'vfs',
          is_healthy: false,
          dependencies_met: false,
          schema_version: 3,
          target_version: 5,
          pending_count: 2,
          issues: ['Pending migrations', 'Missing dependency: chat_v2'],
        },
      ],
    };

    mockInvoke.mockResolvedValue(unhealthy);
    const result = await runHealthCheck();

    expect(result.overall_healthy).toBe(false);
    expect(result.databases[0]!.issues).toHaveLength(2);
    expect(result.databases[0]!.pending_count).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════
//  5. getMigrationStatus
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi.getMigrationStatus() contract', () => {
  const mockMigration: MigrationStatusResponse = {
    global_version: 12,
    all_healthy: true,
    databases: [
      {
        id: 'vfs',
        current_version: 5,
        target_version: 5,
        is_initialized: true,
        last_migration_at: '2026-02-07T08:00:00Z',
        pending_count: 0,
        has_pending: false,
      },
      {
        id: 'chat_v2',
        current_version: 3,
        target_version: 3,
        is_initialized: true,
        last_migration_at: null,
        pending_count: 0,
        has_pending: false,
      },
    ],
    pending_migrations_total: 0,
    has_pending_migrations: false,
    last_error: null,
  };

  it('calls correct invoke command without params', async () => {
    mockInvoke.mockResolvedValue(mockMigration);
    await getMigrationStatus();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0]![0]).toBe('data_governance_get_migration_status');
  });

  it('returns MigrationStatusResponse with correct structure', async () => {
    mockInvoke.mockResolvedValue(mockMigration);
    const result = await getMigrationStatus();

    expect(result).toHaveProperty('global_version');
    expect(result).toHaveProperty('all_healthy');
    expect(result).toHaveProperty('databases');
    expect(result).toHaveProperty('pending_migrations_total');
    expect(result).toHaveProperty('has_pending_migrations');
    expect(result).toHaveProperty('last_error');
    expect(typeof result.global_version).toBe('number');
    expect(typeof result.all_healthy).toBe('boolean');
    expect(Array.isArray(result.databases)).toBe(true);
  });

  it('handles pending migrations with last_error', async () => {
    const pending: MigrationStatusResponse = {
      ...mockMigration,
      all_healthy: false,
      has_pending_migrations: true,
      pending_migrations_total: 3,
      last_error: 'Migration v4 failed: table already exists',
    };

    mockInvoke.mockResolvedValue(pending);
    const result = await getMigrationStatus();

    expect(result.has_pending_migrations).toBe(true);
    expect(result.pending_migrations_total).toBe(3);
    expect(result.last_error).toBe('Migration v4 failed: table already exists');
  });

  it('handles null last_migration_at for uninitialized databases', async () => {
    mockInvoke.mockResolvedValue(mockMigration);
    const result = await getMigrationStatus();

    const chatDb = result.databases.find(db => db.id === 'chat_v2');
    expect(chatDb?.last_migration_at).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
//  6. getAuditLogs
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi.getAuditLogs() contract', () => {
  const mockLogs: AuditLogResponse[] = [
    {
      id: 'log-001',
      timestamp: '2026-02-07T12:00:00Z',
      operation_type: 'Backup',
      target: 'full_backup',
      status: 'Completed',
      duration_ms: 1200,
      error_message: null,
    },
    {
      id: 'log-002',
      timestamp: '2026-02-07T11:00:00Z',
      operation_type: 'Migration',
      target: 'vfs',
      status: 'Failed',
      duration_ms: 300,
      error_message: 'Schema conflict detected',
    },
  ];

  const mockPagedResponse = { logs: mockLogs, total: 2 };

  it('passes all filter params as snake_case', async () => {
    mockInvoke.mockResolvedValue(mockPagedResponse);
    await getAuditLogs('Backup', 'Completed', 50);

    expectSingleInvoke('data_governance_get_audit_logs', {
      operation_type: 'Backup',
      status: 'Completed',
      limit: 50,
      offset: undefined,
    });
  });

  it('passes undefined for omitted optional params', async () => {
    mockInvoke.mockResolvedValue(mockPagedResponse);
    await getAuditLogs();

    expectSingleInvoke('data_governance_get_audit_logs', {
      operation_type: undefined,
      status: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it('passes partial filters correctly', async () => {
    mockInvoke.mockResolvedValue(mockPagedResponse);
    await getAuditLogs('Restore', undefined, 10);

    expectSingleInvoke('data_governance_get_audit_logs', {
      operation_type: 'Restore',
      status: undefined,
      limit: 10,
      offset: undefined,
    });
  });

  it('passes offset for pagination', async () => {
    mockInvoke.mockResolvedValue(mockPagedResponse);
    await getAuditLogs(undefined, undefined, 20, 40);

    expectSingleInvoke('data_governance_get_audit_logs', {
      operation_type: undefined,
      status: undefined,
      limit: 20,
      offset: 40,
    });
  });

  it('returns AuditLogPagedResponse with logs and total', async () => {
    mockInvoke.mockResolvedValue(mockPagedResponse);
    const result = await getAuditLogs();

    expect(result).toHaveProperty('logs');
    expect(result).toHaveProperty('total');
    expect(Array.isArray(result.logs)).toBe(true);
    expect(typeof result.total).toBe('number');
    for (const log of result.logs) {
      expect(log).toHaveProperty('id');
      expect(log).toHaveProperty('timestamp');
      expect(log).toHaveProperty('operation_type');
      expect(log).toHaveProperty('target');
      expect(log).toHaveProperty('status');
      expect(log).toHaveProperty('duration_ms');
      expect(log).toHaveProperty('error_message');
      expect(typeof log.id).toBe('string');
      expect(['Migration', 'Backup', 'Restore', 'Sync']).toContain(log.operation_type);
      expect(['Started', 'Completed', 'Failed', 'Partial']).toContain(log.status);
    }
  });

  it('handles null duration_ms and error_message', async () => {
    const logWithNulls: AuditLogResponse[] = [{
      id: 'log-003',
      timestamp: '2026-02-07T10:00:00Z',
      operation_type: 'Sync',
      target: 'all',
      status: 'Started',
      duration_ms: null,
      error_message: null,
    }];

    mockInvoke.mockResolvedValue({ logs: logWithNulls, total: 1 });
    const result = await getAuditLogs();

    expect(result.logs[0]!.duration_ms).toBeNull();
    expect(result.logs[0]!.error_message).toBeNull();
  });

  it('handles empty audit log list', async () => {
    mockInvoke.mockResolvedValue({ logs: [], total: 0 });
    const result = await getAuditLogs();

    expect(Array.isArray(result.logs)).toBe(true);
    expect(result.logs).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
//  7. Chat V2 迁移 API
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi Chat V2 Migration API contract', () => {
  describe('checkChatMigrationStatus()', () => {
    const mockStatus: ChatMigrationCheckResult = {
      needsMigration: true,
      pendingMessages: 150,
      pendingSessions: 10,
      migratedMessages: 0,
      canRollback: false,
      lastMigrationAt: null,
    };

    it('calls correct invoke command without params', async () => {
      mockInvoke.mockResolvedValue(mockStatus);
      await checkChatMigrationStatus();

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke.mock.calls[0]![0]).toBe('chat_v2_check_migration_status');
      expect(mockInvoke.mock.calls[0]![1]).toBeUndefined();
    });

    it('returns ChatMigrationCheckResult with all fields', async () => {
      mockInvoke.mockResolvedValue(mockStatus);
      const result = await checkChatMigrationStatus();

      expect(result).toHaveProperty('needsMigration');
      expect(result).toHaveProperty('pendingMessages');
      expect(result).toHaveProperty('pendingSessions');
      expect(result).toHaveProperty('migratedMessages');
      expect(result).toHaveProperty('canRollback');
      expect(result).toHaveProperty('lastMigrationAt');
      expect(typeof result.needsMigration).toBe('boolean');
      expect(typeof result.pendingMessages).toBe('number');
      expect(typeof result.pendingSessions).toBe('number');
    });

    it('handles post-migration state with lastMigrationAt set', async () => {
      const migrated: ChatMigrationCheckResult = {
        needsMigration: false,
        pendingMessages: 0,
        pendingSessions: 0,
        migratedMessages: 150,
        canRollback: true,
        lastMigrationAt: 1707264000000,
      };

      mockInvoke.mockResolvedValue(migrated);
      const result = await checkChatMigrationStatus();

      expect(result.needsMigration).toBe(false);
      expect(result.canRollback).toBe(true);
      expect(result.lastMigrationAt).toBe(1707264000000);
    });
  });

  describe('migrateLegacyChat()', () => {
    const mockReport: ChatMigrationReport = {
      status: 'completed',
      sessionsCreated: 10,
      messagesMigrated: 150,
      blocksCreated: 300,
      attachmentsCreated: 20,
      messagesSkipped: 2,
      errors: [],
      startedAt: 1707264000000,
      endedAt: 1707264060000,
      durationMs: 60000,
    };

    it('calls correct invoke command', async () => {
      mockInvoke.mockResolvedValue(mockReport);
      await migrateLegacyChat();

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke.mock.calls[0]![0]).toBe('chat_v2_migrate_legacy_chat');
    });

    it('returns ChatMigrationReport with all fields', async () => {
      mockInvoke.mockResolvedValue(mockReport);
      const result = await migrateLegacyChat();

      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('sessionsCreated');
      expect(result).toHaveProperty('messagesMigrated');
      expect(result).toHaveProperty('blocksCreated');
      expect(result).toHaveProperty('attachmentsCreated');
      expect(result).toHaveProperty('messagesSkipped');
      expect(result).toHaveProperty('errors');
      expect(result).toHaveProperty('startedAt');
      expect(result).toHaveProperty('endedAt');
      expect(result).toHaveProperty('durationMs');
      expect(Array.isArray(result.errors)).toBe(true);
      expect(['not_started', 'in_progress', 'completed', 'rolled_back', 'failed']).toContain(result.status);
    });

    it('handles migration with errors', async () => {
      const failedReport: ChatMigrationReport = {
        ...mockReport,
        status: 'failed',
        messagesMigrated: 50,
        messagesSkipped: 100,
        errors: ['Invalid message format at row 51', 'Duplicate session id'],
      };

      mockInvoke.mockResolvedValue(failedReport);
      const result = await migrateLegacyChat();

      expect(result.status).toBe('failed');
      expect(result.errors).toHaveLength(2);
    });
  });

  describe('rollbackChatMigration()', () => {
    const mockRollbackReport: ChatMigrationReport = {
      status: 'rolled_back',
      sessionsCreated: 0,
      messagesMigrated: 0,
      blocksCreated: 0,
      attachmentsCreated: 0,
      messagesSkipped: 0,
      errors: [],
      startedAt: 1707264000000,
      endedAt: 1707264010000,
      durationMs: 10000,
    };

    it('calls correct invoke command', async () => {
      mockInvoke.mockResolvedValue(mockRollbackReport);
      await rollbackChatMigration();

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke.mock.calls[0]![0]).toBe('chat_v2_rollback_migration');
    });

    it('returns ChatMigrationReport format', async () => {
      mockInvoke.mockResolvedValue(mockRollbackReport);
      const result = await rollbackChatMigration();

      expect(result.status).toBe('rolled_back');
      expect(typeof result.durationMs).toBe('number');
    });
  });
});

// ═══════════════════════════════════════════════════════════
//  8. 媒体缓存 API
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi Media Cache API contract', () => {
  describe('getMediaCacheStats()', () => {
    const mockStats: MediaCacheStats = {
      pdfPreviewCount: 20,
      pdfPreviewSize: 2097152,
      compressedImageCount: 100,
      compressedImageSize: 5242880,
      ocrTextCount: 50,
      vectorIndexCount: 10,
      vectorIndexSize: 1048576,
      totalSize: 8388608,
    };

    it('calls correct invoke command', async () => {
      mockInvoke.mockResolvedValue(mockStats);
      await getMediaCacheStats();

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke.mock.calls[0]![0]).toBe('vfs_get_media_cache_stats');
      expect(mockInvoke.mock.calls[0]![1]).toBeUndefined();
    });

    it('returns MediaCacheStats with all fields', async () => {
      mockInvoke.mockResolvedValue(mockStats);
      const result = await getMediaCacheStats();

      expect(result).toHaveProperty('pdfPreviewCount');
      expect(result).toHaveProperty('pdfPreviewSize');
      expect(result).toHaveProperty('compressedImageCount');
      expect(result).toHaveProperty('compressedImageSize');
      expect(result).toHaveProperty('ocrTextCount');
      expect(result).toHaveProperty('vectorIndexCount');
      expect(result).toHaveProperty('vectorIndexSize');
      expect(result).toHaveProperty('totalSize');
      expect(typeof result.pdfPreviewCount).toBe('number');
      expect(typeof result.totalSize).toBe('number');
    });

    it('handles zero-value stats (empty cache)', async () => {
      const emptyStats: MediaCacheStats = {
        pdfPreviewCount: 0,
        pdfPreviewSize: 0,
        compressedImageCount: 0,
        compressedImageSize: 0,
        ocrTextCount: 0,
        vectorIndexCount: 0,
        vectorIndexSize: 0,
        totalSize: 0,
      };

      mockInvoke.mockResolvedValue(emptyStats);
      const result = await getMediaCacheStats();

      expect(result.totalSize).toBe(0);
      expect(result.pdfPreviewCount).toBe(0);
    });
  });

  describe('clearMediaCache()', () => {
    const mockClearResult: ClearMediaCacheResult = {
      pdfPreviewCleared: 20,
      compressedImagesCleared: 100,
      ocrTextCleared: 50,
      vectorIndexCleared: 10,
      totalBytesFreed: 8388608,
      filesReset: 180,
    };

    it('calls invoke with options wrapped in params', async () => {
      mockInvoke.mockResolvedValue(mockClearResult);
      await clearMediaCache({
        clearPdfPreview: true,
        clearCompressedImages: true,
        clearOcrText: false,
        clearVectorIndex: false,
      });

      expectSingleInvoke('vfs_clear_media_cache', {
        params: {
          clearPdfPreview: true,
          clearCompressedImages: true,
          clearOcrText: false,
          clearVectorIndex: false,
        },
      });
    });

    it('passes undefined when no options provided', async () => {
      mockInvoke.mockResolvedValue(mockClearResult);
      await clearMediaCache();

      expectSingleInvoke('vfs_clear_media_cache', {
        params: undefined,
      });
    });

    it('returns ClearMediaCacheResult with all fields', async () => {
      mockInvoke.mockResolvedValue(mockClearResult);
      const result = await clearMediaCache();

      expect(result).toHaveProperty('pdfPreviewCleared');
      expect(result).toHaveProperty('compressedImagesCleared');
      expect(result).toHaveProperty('ocrTextCleared');
      expect(result).toHaveProperty('vectorIndexCleared');
      expect(result).toHaveProperty('totalBytesFreed');
      expect(result).toHaveProperty('filesReset');
      expect(typeof result.totalBytesFreed).toBe('number');
    });
  });
});

// ═══════════════════════════════════════════════════════════
//  9. Schema & Database Detail API
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi Schema API contract', () => {
  describe('getSchemaRegistry()', () => {
    const mockRegistry: SchemaRegistryResponse = {
      global_version: 12,
      aggregated_at: '2026-02-07T12:00:00Z',
      databases: [
        {
          id: 'vfs',
          schema_version: 5,
          min_compatible_version: 3,
          max_compatible_version: 5,
          data_contract_version: '1.2.0',
          migration_count: 5,
          checksum: 'abc123',
          updated_at: '2026-02-07T12:00:00Z',
        },
      ],
    };

    it('calls correct invoke command', async () => {
      mockInvoke.mockResolvedValue(mockRegistry);
      await getSchemaRegistry();

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke.mock.calls[0]![0]).toBe('data_governance_get_schema_registry');
    });

    it('returns SchemaRegistryResponse with databases array', async () => {
      mockInvoke.mockResolvedValue(mockRegistry);
      const result = await getSchemaRegistry();

      expect(result).toHaveProperty('global_version');
      expect(result).toHaveProperty('aggregated_at');
      expect(result).toHaveProperty('databases');
      expect(Array.isArray(result.databases)).toBe(true);
      expect(result.databases[0]).toHaveProperty('id');
      expect(result.databases[0]).toHaveProperty('schema_version');
      expect(result.databases[0]).toHaveProperty('data_contract_version');
    });
  });

  describe('getDatabaseStatus()', () => {
    const mockDetail: DatabaseDetailResponse = {
      id: 'vfs',
      schema_version: 5,
      min_compatible_version: 3,
      max_compatible_version: 5,
      data_contract_version: '1.2.0',
      checksum: 'abc123',
      updated_at: '2026-02-07T12:00:00Z',
      migration_history: [
        {
          version: 5,
          name: 'add_file_tags',
          checksum: 'mig-hash-5',
          applied_at: '2026-02-07T08:00:00Z',
          duration_ms: 120,
          success: true,
        },
      ],
      dependencies: ['chat_v2'],
    };

    it('passes databaseId as snake_case param', async () => {
      mockInvoke.mockResolvedValue(mockDetail);
      await getDatabaseStatus('vfs');

      expectSingleInvoke('data_governance_get_database_status', {
        database_id: 'vfs',
      });
    });

    it('returns DatabaseDetailResponse with migration history', async () => {
      mockInvoke.mockResolvedValue(mockDetail);
      const result = await getDatabaseStatus('vfs');

      expect(result).not.toBeNull();
      expect(result!).toHaveProperty('migration_history');
      expect(Array.isArray(result!.migration_history)).toBe(true);
      expect(result!.migration_history[0]).toHaveProperty('version');
      expect(result!.migration_history[0]).toHaveProperty('name');
      expect(result!.migration_history[0]).toHaveProperty('success');
    });

    it('returns null for unknown database', async () => {
      mockInvoke.mockResolvedValue(null);
      const result = await getDatabaseStatus('nonexistent');

      expect(result).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════
//  10. Backup Management API (delete, verify, cancel, job)
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi Backup Management contract', () => {
  describe('deleteBackup()', () => {
    it('passes backupId as snake_case param', async () => {
      mockInvoke.mockResolvedValue(true);
      await deleteBackup('backup-2026-02-07');

      expectSingleInvoke('data_governance_delete_backup', {
        backup_id: 'backup-2026-02-07',
      });
    });

    it('returns boolean', async () => {
      mockInvoke.mockResolvedValue(true);
      const result = await deleteBackup('id');
      expect(typeof result).toBe('boolean');
    });
  });

  describe('verifyBackup()', () => {
    const mockVerify: BackupVerifyResponse = {
      is_valid: true,
      checksum_match: true,
      databases_verified: [
        { id: 'vfs', is_valid: true, error: null },
        { id: 'chat_v2', is_valid: true, error: null },
      ],
      errors: [],
    };

    it('passes backupId correctly', async () => {
      mockInvoke.mockResolvedValue(mockVerify);
      await verifyBackup('backup-id');

      expectSingleInvoke('data_governance_verify_backup', {
        backup_id: 'backup-id',
      });
    });

    it('returns BackupVerifyResponse with database details', async () => {
      mockInvoke.mockResolvedValue(mockVerify);
      const result = await verifyBackup('backup-id');

      expect(result).toHaveProperty('is_valid');
      expect(result).toHaveProperty('checksum_match');
      expect(result).toHaveProperty('databases_verified');
      expect(result).toHaveProperty('errors');
      expect(Array.isArray(result.databases_verified)).toBe(true);
    });
  });

  describe('cancelBackup()', () => {
    it('passes jobId as snake_case param', async () => {
      mockInvoke.mockResolvedValue(true);
      await cancelBackup('job-123');

      expectSingleInvoke('data_governance_cancel_backup', {
        job_id: 'job-123',
      });
    });
  });

  describe('getBackupJob()', () => {
    const mockJob: BackupJobSummary = {
      job_id: 'job-123',
      kind: 'export',
      status: 'running',
      phase: 'copying',
      progress: 45,
      message: 'Copying databases...',
      created_at: '2026-02-07T12:00:00Z',
      started_at: '2026-02-07T12:00:01Z',
      finished_at: undefined,
      result: undefined,
    };

    it('passes jobId correctly', async () => {
      mockInvoke.mockResolvedValue(mockJob);
      await getBackupJob('job-123');

      expectSingleInvoke('data_governance_get_backup_job', {
        job_id: 'job-123',
      });
    });

    it('returns BackupJobSummary or null', async () => {
      mockInvoke.mockResolvedValue(mockJob);
      const result = await getBackupJob('job-123');

      expect(result).not.toBeNull();
      expect(result!).toHaveProperty('job_id');
      expect(result!).toHaveProperty('kind');
      expect(result!).toHaveProperty('status');
      expect(result!).toHaveProperty('phase');
      expect(result!).toHaveProperty('progress');
    });

    it('returns null for nonexistent job', async () => {
      mockInvoke.mockResolvedValue(null);
      const result = await getBackupJob('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('listBackupJobs()', () => {
    it('calls correct invoke command', async () => {
      mockInvoke.mockResolvedValue([]);
      await listBackupJobs();

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke.mock.calls[0]![0]).toBe('data_governance_list_backup_jobs');
    });

    it('returns BackupJobSummary[]', async () => {
      mockInvoke.mockResolvedValue([]);
      const result = await listBackupJobs();
      expect(Array.isArray(result)).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════
//  11. 任务恢复 API
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi Resume Jobs contract', () => {
  describe('resumeBackupJob()', () => {
    const mockResponse: BackupJobStartResponse = {
      job_id: 'job-resumed',
      kind: 'export',
      status: 'queued',
      message: 'Job resumed from checkpoint',
    };

    it('passes jobId as snake_case param', async () => {
      mockInvoke.mockResolvedValue(mockResponse);
      await resumeBackupJob('job-failed-1');

      expectSingleInvoke('data_governance_resume_backup_job', {
        job_id: 'job-failed-1',
      });
    });

    it('returns BackupJobStartResponse', async () => {
      mockInvoke.mockResolvedValue(mockResponse);
      const result = await resumeBackupJob('job-failed-1');

      expect(result.job_id).toBe('job-resumed');
      expect(result.status).toBe('queued');
    });
  });

  describe('listResumableJobs()', () => {
    it('calls correct invoke command', async () => {
      mockInvoke.mockResolvedValue([]);
      await listResumableJobs();

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke.mock.calls[0]![0]).toBe('data_governance_list_resumable_jobs');
    });

    it('normalizes snake_case response items', async () => {
      mockInvoke.mockResolvedValue([
        {
          job_id: 'job-1',
          kind: 'export',
          phase: 'copy',
          progress: 30,
          created_at: '2026-02-07T12:00:00Z',
          message: 'Interrupted',
        },
      ]);

      const result = await listResumableJobs();

      expect(result).toHaveLength(1);
      expect(result[0]!.job_id).toBe('job-1');
      expect(result[0]!.kind).toBe('export');
      expect(result[0]!.progress).toBe(30);
    });

    it('normalizes camelCase response items', async () => {
      mockInvoke.mockResolvedValue([
        {
          jobId: 'job-2',
          kind: 'import',
          phase: 'extract',
          progress: 60,
          createdAt: '2026-02-07T12:00:00Z',
        },
      ]);

      const result = await listResumableJobs();

      expect(result).toHaveLength(1);
      expect(result[0]!.job_id).toBe('job-2');
      expect(result[0]!.created_at).toBe('2026-02-07T12:00:00Z');
    });

    it('filters out invalid items', async () => {
      mockInvoke.mockResolvedValue([
        null,
        { kind: 'export' }, // missing job_id
        { job_id: 'ok', kind: 'export', phase: 'p', progress: 10, created_at: 'now' },
      ]);

      const result = await listResumableJobs();
      expect(result).toHaveLength(1);
      expect(result[0]!.job_id).toBe('ok');
    });

    it('returns empty array for non-array response', async () => {
      mockInvoke.mockResolvedValue(null);
      const result = await listResumableJobs();
      expect(result).toEqual([]);
    });
  });

  describe('cleanupPersistedJobs()', () => {
    it('calls correct invoke command and returns number', async () => {
      mockInvoke.mockResolvedValue(5);
      const result = await cleanupPersistedJobs();

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke.mock.calls[0]![0]).toBe('data_governance_cleanup_persisted_jobs');
      expect(result).toBe(5);
    });
  });
});

// ═══════════════════════════════════════════════════════════
//  12. 分层备份 API
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi.backupTiered() contract', () => {
  const mockResponse: BackupJobStartResponse = {
    job_id: 'tiered-job-1',
    kind: 'export',
    status: 'queued',
    message: 'Tiered backup queued',
  };

  it('passes all params as snake_case', async () => {
    mockInvoke.mockResolvedValue(mockResponse);
    await backupTiered(['core', 'important'], ['vfs'], ['llm_usage'], true, 104857600);

    expectSingleInvoke('data_governance_backup_tiered', {
      tiers: ['core', 'important'],
      include_databases: ['vfs'],
      exclude_databases: ['llm_usage'],
      include_assets: true,
      max_asset_size: 104857600,
    });
  });

  it('passes undefined for omitted params', async () => {
    mockInvoke.mockResolvedValue(mockResponse);
    await backupTiered();

    expectSingleInvoke('data_governance_backup_tiered', {
      tiers: undefined,
      include_databases: undefined,
      exclude_databases: undefined,
      include_assets: undefined,
      max_asset_size: undefined,
    });
  });
});

describe('DataGovernanceApi.backupAndExportZip() contract', () => {
  const mockResponse: BackupJobStartResponse = {
    job_id: 'backup-export-job-1',
    kind: 'export',
    status: 'queued',
    message: 'Backup and export queued',
  };

  it('passes all params to unified backup-export command', async () => {
    mockInvoke.mockResolvedValue(mockResponse);
    await backupAndExportZip(
      '/tmp/full-backup.zip',
      6,
      true,
      true,
      ['core', 'important'],
      true,
      ['images'],
    );

    expectSingleInvoke('data_governance_backup_and_export_zip', {
      output_path: '/tmp/full-backup.zip',
      compression_level: 6,
      add_to_backup_list: true,
      use_tiered: true,
      tiers: ['core', 'important'],
      include_assets: true,
      asset_types: ['images'],
    });
  });
});

// ═══════════════════════════════════════════════════════════
//  13. ZIP 导出/导入 API
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi ZIP Export/Import contract', () => {
  const mockResponse: BackupJobStartResponse = {
    job_id: 'zip-job-1',
    kind: 'export',
    status: 'queued',
    message: 'ZIP export queued',
  };

  describe('exportZip()', () => {
    it('passes all params as snake_case', async () => {
      mockInvoke.mockResolvedValue(mockResponse);
      await exportZip('backup-id', '/tmp/export.zip', 6, true);

      expectSingleInvoke('data_governance_export_zip', {
        backup_id: 'backup-id',
        output_path: '/tmp/export.zip',
        compression_level: 6,
        include_checksums: true,
      });
    });

    it('passes undefined for optional params', async () => {
      mockInvoke.mockResolvedValue(mockResponse);
      await exportZip('backup-id');

      expectSingleInvoke('data_governance_export_zip', {
        backup_id: 'backup-id',
        output_path: undefined,
        compression_level: undefined,
        include_checksums: undefined,
      });
    });
  });

  describe('importZip()', () => {
    it('passes zipPath as snake_case param', async () => {
      mockInvoke.mockResolvedValue({ ...mockResponse, kind: 'import' });
      await importZip('/tmp/backup.zip', 'imported-backup');

      expectSingleInvoke('data_governance_import_zip', {
        zip_path: '/tmp/backup.zip',
        backup_id: 'imported-backup',
      });
    });

    it('passes undefined for optional backupId', async () => {
      mockInvoke.mockResolvedValue({ ...mockResponse, kind: 'import' });
      await importZip('/tmp/backup.zip');

      expectSingleInvoke('data_governance_import_zip', {
        zip_path: '/tmp/backup.zip',
        backup_id: undefined,
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════
//  14. 资产管理 API
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi Asset Management contract', () => {
  describe('scanAssets()', () => {
    it('passes assetTypes as snake_case param', async () => {
      mockInvoke.mockResolvedValue({ by_type: {}, total_files: 0, total_size: 0 });
      await scanAssets(['images', 'documents']);

      expectSingleInvoke('data_governance_scan_assets', {
        asset_types: ['images', 'documents'],
      });
    });

    it('passes undefined when no types specified', async () => {
      mockInvoke.mockResolvedValue({ by_type: {}, total_files: 0, total_size: 0 });
      await scanAssets();

      expectSingleInvoke('data_governance_scan_assets', {
        asset_types: undefined,
      });
    });
  });

  describe('getAssetTypes()', () => {
    it('calls correct invoke command', async () => {
      mockInvoke.mockResolvedValue([]);
      await getAssetTypes();

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke.mock.calls[0]![0]).toBe('data_governance_get_asset_types');
    });
  });

  describe('restoreWithAssets()', () => {
    it('passes params as snake_case', async () => {
      mockInvoke.mockResolvedValue({ success: true, backup_id: 'id', duration_ms: 100, databases_restored: [] });
      await restoreWithAssets('backup-id', true);

      expectSingleInvoke('data_governance_restore_with_assets', {
        backup_id: 'backup-id',
        restore_assets: true,
      });
    });
  });

  describe('verifyBackupWithAssets()', () => {
    it('passes backupId correctly', async () => {
      mockInvoke.mockResolvedValue({
        is_valid: true,
        database_errors: [],
        asset_errors: [],
        has_assets: true,
        asset_file_count: 10,
      });
      await verifyBackupWithAssets('backup-id');

      expectSingleInvoke('data_governance_verify_backup_with_assets', {
        backup_id: 'backup-id',
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════
//  15. autoVerifyLatestBackup
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi.autoVerifyLatestBackup() contract', () => {
  const mockResponse: AutoVerifyResponse = {
    backup_id: 'backup-2026-02-07',
    is_valid: true,
    verified_at: '2026-02-07T14:00:00Z',
    duration_ms: 850,
    databases_verified: [
      { id: 'vfs', is_valid: true, error: null },
      { id: 'chat_v2', is_valid: true, error: null },
    ],
    errors: [],
  };

  it('calls invoke with correct command name and no params', async () => {
    mockInvoke.mockResolvedValue(mockResponse);
    await autoVerifyLatestBackup();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0]![0]).toBe('data_governance_auto_verify_latest_backup');
    expect(mockInvoke.mock.calls[0]![1]).toBeUndefined();
  });

  it('returns AutoVerifyResponse with all required fields', async () => {
    mockInvoke.mockResolvedValue(mockResponse);
    const result = await autoVerifyLatestBackup();

    expect(result).toHaveProperty('backup_id');
    expect(result).toHaveProperty('is_valid');
    expect(result).toHaveProperty('verified_at');
    expect(result).toHaveProperty('duration_ms');
    expect(result).toHaveProperty('databases_verified');
    expect(result).toHaveProperty('errors');
    expect(typeof result.backup_id).toBe('string');
    expect(typeof result.is_valid).toBe('boolean');
    expect(typeof result.verified_at).toBe('string');
    expect(typeof result.duration_ms).toBe('number');
    expect(Array.isArray(result.databases_verified)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it('handles failed verification with errors', async () => {
    const failedResponse: AutoVerifyResponse = {
      backup_id: 'backup-2026-02-07',
      is_valid: false,
      verified_at: '2026-02-07T14:00:00Z',
      duration_ms: 1200,
      databases_verified: [
        { id: 'vfs', is_valid: false, error: 'integrity_check failed: page 42 corrupt' },
        { id: 'chat_v2', is_valid: true, error: null },
      ],
      errors: ['Database vfs failed integrity check'],
    };

    mockInvoke.mockResolvedValue(failedResponse);
    const result = await autoVerifyLatestBackup();

    expect(result.is_valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.databases_verified[0]!.is_valid).toBe(false);
    expect(result.databases_verified[0]!.error).toBe('integrity_check failed: page 42 corrupt');
  });
});

// ═══════════════════════════════════════════════════════════
//  16. checkDiskSpaceForRestore
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi.checkDiskSpaceForRestore() contract', () => {
  const mockResponse: DiskSpaceCheckResponse = {
    has_enough_space: true,
    available_bytes: 10737418240,
    required_bytes: 2147483648,
    backup_size: 1073741824,
  };

  it('passes backupId as snake_case param', async () => {
    mockInvoke.mockResolvedValue(mockResponse);
    await checkDiskSpaceForRestore('backup-2026-02-07');

    expectSingleInvoke('data_governance_check_disk_space_for_restore', {
      backup_id: 'backup-2026-02-07',
    });
  });

  it('returns DiskSpaceCheckResponse with all required fields', async () => {
    mockInvoke.mockResolvedValue(mockResponse);
    const result = await checkDiskSpaceForRestore('backup-id');

    expect(result).toHaveProperty('has_enough_space');
    expect(result).toHaveProperty('available_bytes');
    expect(result).toHaveProperty('required_bytes');
    expect(result).toHaveProperty('backup_size');
    expect(typeof result.has_enough_space).toBe('boolean');
    expect(typeof result.available_bytes).toBe('number');
    expect(typeof result.required_bytes).toBe('number');
    expect(typeof result.backup_size).toBe('number');
  });

  it('returns insufficient space response', async () => {
    const insufficient: DiskSpaceCheckResponse = {
      has_enough_space: false,
      available_bytes: 524288000,
      required_bytes: 2147483648,
      backup_size: 1073741824,
    };

    mockInvoke.mockResolvedValue(insufficient);
    const result = await checkDiskSpaceForRestore('large-backup');

    expect(result.has_enough_space).toBe(false);
    expect(result.available_bytes).toBeLessThan(result.required_bytes);
  });

  it('returns fallback response when backend command is unavailable', async () => {
    mockInvoke.mockRejectedValue(new Error('Command not found'));
    const result = await checkDiskSpaceForRestore('any-backup');

    // The API has a try-catch that returns a safe fallback
    expect(result.has_enough_space).toBe(true);
    expect(result.available_bytes).toBe(0);
    expect(result.required_bytes).toBe(0);
    expect(result.backup_size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
//  17. getBackupConfig / setBackupConfig
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi Backup Config contract', () => {
  const mockConfig: BackupConfig = {
    backupDirectory: '/custom/backup/dir',
    autoBackupEnabled: true,
    autoBackupIntervalHours: 12,
    maxBackupCount: 10,
    slimBackup: false,
  };

  describe('getBackupConfig()', () => {
    it('calls invoke with correct command name and no params', async () => {
      mockInvoke.mockResolvedValue(mockConfig);
      await getBackupConfig();

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke.mock.calls[0]![0]).toBe('get_backup_config');
      expect(mockInvoke.mock.calls[0]![1]).toBeUndefined();
    });

    it('returns BackupConfig with all required fields', async () => {
      mockInvoke.mockResolvedValue(mockConfig);
      const result = await getBackupConfig();

      expect(result).toHaveProperty('backupDirectory');
      expect(result).toHaveProperty('autoBackupEnabled');
      expect(result).toHaveProperty('autoBackupIntervalHours');
      expect(result).toHaveProperty('maxBackupCount');
      expect(result).toHaveProperty('slimBackup');
      expect(typeof result.autoBackupEnabled).toBe('boolean');
      expect(typeof result.autoBackupIntervalHours).toBe('number');
      expect(typeof result.slimBackup).toBe('boolean');
    });

    it('handles null backupDirectory (default directory)', async () => {
      const defaultConfig: BackupConfig = {
        ...mockConfig,
        backupDirectory: null,
        maxBackupCount: null,
      };

      mockInvoke.mockResolvedValue(defaultConfig);
      const result = await getBackupConfig();

      expect(result.backupDirectory).toBeNull();
      expect(result.maxBackupCount).toBeNull();
    });

    it('handles optional backupTiers field', async () => {
      const configWithTiers: BackupConfig = {
        ...mockConfig,
        backupTiers: ['core', 'important'],
      };

      mockInvoke.mockResolvedValue(configWithTiers);
      const result = await getBackupConfig();

      expect(result.backupTiers).toEqual(['core', 'important']);
    });
  });

  describe('setBackupConfig()', () => {
    it('calls invoke with correct command name and config param', async () => {
      mockInvoke.mockResolvedValue(undefined);
      await setBackupConfig(mockConfig);

      expectSingleInvoke('set_backup_config', {
        config: mockConfig,
      });
    });

    it('passes config object as-is (camelCase — no snake_case conversion)', async () => {
      mockInvoke.mockResolvedValue(undefined);
      const config: BackupConfig = {
        backupDirectory: '/new/path',
        autoBackupEnabled: false,
        autoBackupIntervalHours: 24,
        maxBackupCount: 5,
        slimBackup: true,
      };

      await setBackupConfig(config);

      const passedConfig = mockInvoke.mock.calls[0]![1]!.config;
      expect(passedConfig.backupDirectory).toBe('/new/path');
      expect(passedConfig.autoBackupEnabled).toBe(false);
      expect(passedConfig.autoBackupIntervalHours).toBe(24);
      expect(passedConfig.maxBackupCount).toBe(5);
      expect(passedConfig.slimBackup).toBe(true);
    });

    it('returns void (undefined)', async () => {
      mockInvoke.mockResolvedValue(undefined);
      const result = await setBackupConfig(mockConfig);

      expect(result).toBeUndefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════
//  18. cleanupAuditLogs
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi.cleanupAuditLogs() contract', () => {
  it('passes keepRecent and beforeDays as snake_case params', async () => {
    mockInvoke.mockResolvedValue(42);
    await cleanupAuditLogs(100, 30);

    expectSingleInvoke('data_governance_cleanup_audit_logs', {
      keep_recent: 100,
      before_days: 30,
    });
  });

  it('passes undefined for omitted optional params', async () => {
    mockInvoke.mockResolvedValue(0);
    await cleanupAuditLogs();

    expectSingleInvoke('data_governance_cleanup_audit_logs', {
      keep_recent: undefined,
      before_days: undefined,
    });
  });

  it('passes only keepRecent when beforeDays omitted', async () => {
    mockInvoke.mockResolvedValue(10);
    await cleanupAuditLogs(50);

    expectSingleInvoke('data_governance_cleanup_audit_logs', {
      keep_recent: 50,
      before_days: undefined,
    });
  });

  it('passes only beforeDays when keepRecent omitted', async () => {
    mockInvoke.mockResolvedValue(25);
    await cleanupAuditLogs(undefined, 90);

    expectSingleInvoke('data_governance_cleanup_audit_logs', {
      keep_recent: undefined,
      before_days: 90,
    });
  });

  it('returns number (deleted count)', async () => {
    mockInvoke.mockResolvedValue(42);
    const result = await cleanupAuditLogs(100);

    expect(typeof result).toBe('number');
    expect(result).toBe(42);
  });

  it('returns 0 when no logs to clean', async () => {
    mockInvoke.mockResolvedValue(0);
    const result = await cleanupAuditLogs();

    expect(result).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
//  19. getMaintenanceStatus
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi.getMaintenanceStatus() contract', () => {
  it('calls invoke with correct command name and no params', async () => {
    mockInvoke.mockResolvedValue({ is_in_maintenance_mode: false });
    await getMaintenanceStatus();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0]![0]).toBe('data_governance_get_maintenance_status');
    expect(mockInvoke.mock.calls[0]![1]).toBeUndefined();
  });

  it('returns maintenance status as false', async () => {
    mockInvoke.mockResolvedValue({ is_in_maintenance_mode: false });
    const result = await getMaintenanceStatus();

    expect(result).toHaveProperty('is_in_maintenance_mode');
    expect(typeof result.is_in_maintenance_mode).toBe('boolean');
    expect(result.is_in_maintenance_mode).toBe(false);
  });

  it('returns maintenance status as true', async () => {
    mockInvoke.mockResolvedValue({ is_in_maintenance_mode: true });
    const result = await getMaintenanceStatus();

    expect(result.is_in_maintenance_mode).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
//  20. Chat 迁移 — 错误场景补充
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi Chat V2 Migration error scenarios', () => {
  it('checkChatMigrationStatus rejection propagates as thrown error', async () => {
    mockInvoke.mockRejectedValue(new Error('Database locked'));
    await expect(checkChatMigrationStatus()).rejects.toThrow('Database locked');
  });

  it('migrateLegacyChat rejection propagates as thrown error', async () => {
    mockInvoke.mockRejectedValue(new Error('Migration already in progress'));
    await expect(migrateLegacyChat()).rejects.toThrow('Migration already in progress');
  });

  it('rollbackChatMigration rejection propagates as thrown error', async () => {
    mockInvoke.mockRejectedValue(new Error('Nothing to rollback'));
    await expect(rollbackChatMigration()).rejects.toThrow('Nothing to rollback');
  });

  it('migrateLegacyChat handles partial failure report', async () => {
    const partialReport: ChatMigrationReport = {
      status: 'failed',
      sessionsCreated: 5,
      messagesMigrated: 75,
      blocksCreated: 150,
      attachmentsCreated: 10,
      messagesSkipped: 75,
      errors: [
        'Foreign key constraint violated at session 6',
        'Message too large at row 76',
        'Attachment file missing: /path/to/file.pdf',
      ],
      startedAt: 1707264000000,
      endedAt: 1707264030000,
      durationMs: 30000,
    };

    mockInvoke.mockResolvedValue(partialReport);
    const result = await migrateLegacyChat();

    expect(result.status).toBe('failed');
    expect(result.messagesMigrated).toBe(75);
    expect(result.messagesSkipped).toBe(75);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toContain('Foreign key');
  });

  it('rollbackChatMigration handles rollback failure', async () => {
    const failedRollback: ChatMigrationReport = {
      status: 'failed',
      sessionsCreated: 0,
      messagesMigrated: 0,
      blocksCreated: 0,
      attachmentsCreated: 0,
      messagesSkipped: 0,
      errors: ['Rollback failed: backup not found'],
      startedAt: 1707264000000,
      endedAt: 1707264005000,
      durationMs: 5000,
    };

    mockInvoke.mockResolvedValue(failedRollback);
    const result = await rollbackChatMigration();

    expect(result.status).toBe('failed');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Rollback failed');
  });
});

// ═══════════════════════════════════════════════════════════
//  21. 边缘情况与容错测试
// ═══════════════════════════════════════════════════════════

describe('DataGovernanceApi edge cases', () => {
  it('invoke rejection propagates as thrown error', async () => {
    mockInvoke.mockRejectedValue(new Error('Backend unavailable'));
    await expect(runBackup()).rejects.toThrow('Backend unavailable');
  });

  it('invoke rejection on restore propagates correctly', async () => {
    mockInvoke.mockRejectedValue(new Error('Backup not found'));
    await expect(restoreBackup('nonexistent')).rejects.toThrow('Backup not found');
  });

  it('response with extra fields does not break consumer', async () => {
    const responseWithExtra = {
      job_id: 'job-1',
      kind: 'export',
      status: 'queued',
      message: 'ok',
      _extra_field: true,
      _debug_info: { timestamp: Date.now() },
    };

    mockInvoke.mockResolvedValue(responseWithExtra);
    const result = await runBackup();

    // Core fields accessible
    expect(result.job_id).toBe('job-1');
    expect(result.kind).toBe('export');
    // Extra fields do not cause errors (TypeScript erases at runtime)
    expect((result as Record<string, unknown>)['_extra_field']).toBe(true);
  });

  it('getBackupList tolerates items with extra fields', async () => {
    const listWithExtras: Array<BackupInfoResponse & Record<string, unknown>> = [
      {
        path: '/backups/test',
        created_at: '2026-02-07T00:00:00Z',
        size: 100,
        backup_type: 'full',
        databases: ['vfs'],
        _metadata: { version: 2 },
      },
    ];

    mockInvoke.mockResolvedValue(listWithExtras);
    const result = await getBackupList();

    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe('/backups/test');
  });

  it('health check with empty databases array', async () => {
    const emptyHealth: HealthCheckResponse = {
      overall_healthy: true,
      total_databases: 0,
      initialized_count: 0,
      uninitialized_count: 0,
      dependency_check_passed: true,
      dependency_error: null,
      databases: [],
      checked_at: '2026-02-07T12:00:00Z',
      pending_migrations_count: 0,
      has_pending_migrations: false,
    };

    mockInvoke.mockResolvedValue(emptyHealth);
    const result = await runHealthCheck();

    expect(result.databases).toEqual([]);
    expect(result.total_databases).toBe(0);
  });
});
