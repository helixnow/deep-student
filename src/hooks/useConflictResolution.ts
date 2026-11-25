/**
 * 数据同步冲突解决 Hook
 *
 * 提供与后端数据治理系统的冲突检测和记录级解决交互。
 * 注意：旧版清单级批量覆盖接口 `data_governance_resolve_conflicts` 已停用，
 * 所有冲突解决统一走记录级 `data_governance_resolve_record_conflict`。
 */

import { useState, useCallback } from 'react';
import {
  getSyncStatus as apiGetSyncStatus,
  detectConflicts as apiDetectConflicts,
  countRecordConflicts as apiCountRecordConflicts,
  listRecordConflicts as apiListRecordConflicts,
  resolveRecordConflict as apiResolveRecordConflict,
} from '@/api/dataGovernance';
import { loadStoredCloudStorageConfigWithCredentials } from '@/utils/cloudStorageApi';
import { useGlobalSyncStore } from '@/stores/syncStatusStore';
import type {
  ConflictDetectionResult,
  DatabaseConflict,
  RecordConflict,
} from '@/components/ConflictResolutionDialog';

export type RecordResolutionAction = 'keep_local' | 'keep_cloud' | 'keep_both' | 'merged';

// ============================================================================
// 后端响应类型
// ============================================================================

/** 冲突检测响应 */
interface ConflictDetectionResponse {
  has_conflicts: boolean;
  needs_migration: boolean;
  database_conflicts: Array<{
    database_name: string;
    conflict_type: string;
    local_version: number | null;
    cloud_version: number | null;
    local_schema_version: number | null;
    cloud_schema_version: number | null;
  }>;
  record_conflict_count: number;
  local_manifest_json: string | null;
  cloud_manifest_json?: string | null;
}

/** 同步结果响应 */
interface SyncResultResponse {
  success: boolean;
  strategy: string;
  synced_databases: number;
  resolved_conflicts: number;
  pending_manual_conflicts: number;
  records_to_push: string[];
  records_to_pull: string[];
  duration_ms: number;
  error_message: string | null;
}

/** 同步状态响应 */
interface SyncStatusResponse {
  has_pending_changes: boolean;
  total_pending_changes: number;
  total_synced_changes: number;
  databases: Array<{
    id: string;
    has_change_log: boolean;
    pending_changes: number;
    synced_changes: number;
    last_sync_at: string | null;
  }>;
  last_sync_at: string | null;
  device_id: string;
}

// ============================================================================
// 状态类型
// ============================================================================

export interface ConflictResolutionState {
  /** 是否正在检测冲突 */
  isDetecting: boolean;
  /** 是否正在解决冲突 */
  isResolving: boolean;
  /** 冲突检测结果 */
  conflicts: ConflictDetectionResult | null;
  /** 同步状态 */
  syncStatus: SyncStatusResponse | null;
  /** 本地清单 JSON（用于调试） */
  localManifestJson: string | null;
  /** 云端清单 JSON（用于冲突解决） */
  cloudManifestJson: string | null;
  /** 错误信息 */
  error: string | null;
  /** 最后一次操作结果 */
  lastResult: SyncResultResponse | null;
}

// ============================================================================
// Hook 实现
// ============================================================================

export function useConflictResolution() {
  const [state, setState] = useState<ConflictResolutionState>({
    isDetecting: false,
    isResolving: false,
    conflicts: null,
    syncStatus: null,
    localManifestJson: null,
    cloudManifestJson: null,
    error: null,
    lastResult: null,
  });

  /**
   * 获取同步状态
   */
  const getSyncStatus = useCallback(async () => {
    try {
      // 使用 API 层的函数，已经包含正确的插件前缀
      const response = await apiGetSyncStatus() as unknown as SyncStatusResponse;
      setState((prev) => ({
        ...prev,
        syncStatus: response,
        error: null,
      }));
      return response;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setState((prev) => ({
        ...prev,
        error: errorMessage,
      }));
      throw error;
    }
  }, []);

  /**
   * 检测冲突
   *
   * @param cloudManifestJson - 云端同步清单的 JSON 字符串（可选）
   */
  const detectConflicts = useCallback(async (cloudManifestJson?: string) => {
    setState((prev) => ({
      ...prev,
      isDetecting: true,
      error: null,
    }));

    try {
      // 若未显式提供 cloudManifestJson，则尝试从云存储配置读取并由后端下载云端清单
      const cloudConfig =
        cloudManifestJson == null
          ? await loadStoredCloudStorageConfigWithCredentials()
          : null;

      const [response, recordCounts] = await Promise.all([
        apiDetectConflicts(
          cloudManifestJson,
          cloudConfig ?? undefined
        ) as unknown as Promise<ConflictDetectionResponse>,
        typeof apiCountRecordConflicts === 'function'
          ? apiCountRecordConflicts().catch(() => null)
          : Promise.resolve(null),
      ]);

      const unresolvedRecordGroups = recordCounts?.total_groups ?? 0;
      if (recordCounts) {
        useGlobalSyncStore.getState().setUnresolvedConflictCount(
          unresolvedRecordGroups,
          recordCounts.per_database,
        );
      }

      const effectiveRecordCount = Math.max(
        response.record_conflict_count ?? 0,
        unresolvedRecordGroups,
      );

      // 转换后端响应为前端格式
      const conflicts: ConflictDetectionResult = {
        has_conflicts: Boolean(response.has_conflicts || effectiveRecordCount > 0),
        needs_migration: response.needs_migration,
        database_conflicts: response.database_conflicts.map((c) => ({
          database_name: c.database_name,
          conflict_type: c.conflict_type as DatabaseConflict['conflict_type'],
          local_state: c.local_version != null
            ? {
                schema_version: c.local_schema_version ?? 0,
                data_version: c.local_version,
                checksum: '',
                last_updated_at: undefined,
              }
            : undefined,
          cloud_state: c.cloud_version != null
            ? {
                schema_version: c.cloud_schema_version ?? 0,
                data_version: c.cloud_version,
                checksum: '',
                last_updated_at: undefined,
              }
            : undefined,
        })),
        record_conflicts: [], // 记录级冲突详情由 RecordConflictsPanel 或 listRecordConflicts 按需加载
        record_conflict_count: effectiveRecordCount,
      };

      setState((prev) => ({
        ...prev,
        isDetecting: false,
        conflicts,
        localManifestJson: response.local_manifest_json,
        cloudManifestJson: response.cloud_manifest_json ?? null,
        error: null,
      }));

      return conflicts;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setState((prev) => ({
        ...prev,
        isDetecting: false,
        error: errorMessage,
      }));
      throw error;
    }
  }, []);

  /**
   * 解决单条记录级冲突（支持 keep_local / keep_cloud / keep_both / merged）。
   * 绝不调用已停用的批量清单级覆盖接口 `data_governance_resolve_conflicts`。
   */
  const resolveRecordConflict = useCallback(
    async (
      databaseName: string,
      tableName: string,
      recordId: string,
      resolution: RecordResolutionAction,
      expectedConflictIds: number[],
      mergedDataJson?: string,
    ) => {
      const startedAt = Date.now();
      setState((prev) => ({
        ...prev,
        isResolving: true,
        error: null,
      }));

      try {
        await apiResolveRecordConflict(
          databaseName,
          tableName,
          recordId,
          resolution as Parameters<typeof apiResolveRecordConflict>[3],
          expectedConflictIds,
          mergedDataJson,
        );
        const remaining = await useGlobalSyncStore.getState().refreshUnresolvedConflictCount();
        const result: SyncResultResponse = {
          success: true,
          strategy: resolution,
          synced_databases: 1,
          resolved_conflicts: 1,
          pending_manual_conflicts: remaining,
          records_to_push: [],
          records_to_pull: [],
          duration_ms: Date.now() - startedAt,
          error_message: null,
        };
        setState((prev) => ({
          ...prev,
          isResolving: false,
          lastResult: result,
          conflicts: prev.conflicts
            ? {
                ...prev.conflicts,
                has_conflicts: remaining > 0 || prev.conflicts.database_conflicts.length > 0,
                record_conflict_count: remaining,
              }
            : null,
          error: null,
        }));
        return result;
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        setState((prev) => ({
          ...prev,
          isResolving: false,
          error: errorMessage,
        }));
        throw error;
      }
    },
    []
  );

  /**
   * 刷新当前未解决记录级冲突列表（供独立调用方使用）
   */
  const loadRecordConflicts = useCallback(async (limit = 200, offset = 0) => {
    const rows = await apiListRecordConflicts(limit, offset);
    await useGlobalSyncStore.getState().refreshUnresolvedConflictCount();
    return rows;
  }, []);

  /**
   * 模拟检测冲突（用于测试）
   *
   * 生成模拟的冲突数据，用于 UI 测试。
   */
  const detectConflictsMock = useCallback(async () => {
    setState((prev) => ({
      ...prev,
      isDetecting: true,
      error: null,
    }));

    // 模拟网络延迟
    await new Promise((resolve) => setTimeout(resolve, 800));

    const mockConflicts: ConflictDetectionResult = {
      has_conflicts: true,
      needs_migration: false,
      database_conflicts: [
        {
          database_name: 'chat_v2',
          conflict_type: 'DataConflict',
          local_state: {
            schema_version: 5,
            data_version: 156,
            checksum: 'abc123def456',
            last_updated_at: '2026-01-30T10:30:00Z',
          },
          cloud_state: {
            schema_version: 5,
            data_version: 158,
            checksum: 'xyz789uvw012',
            last_updated_at: '2026-01-30T11:00:00Z',
          },
        },
        {
          database_name: 'vfs',
          conflict_type: 'LocalOnly',
          local_state: {
            schema_version: 3,
            data_version: 42,
            checksum: 'vfs123hash456',
            last_updated_at: '2026-01-29T15:00:00Z',
          },
          cloud_state: undefined,
        },
      ],
      record_conflicts: [
        {
          database_name: 'chat_v2',
          table_name: 'messages',
          record_id: 'msg-uuid-12345',
          local_version: 3,
          cloud_version: 4,
          local_updated_at: '2026-01-30T10:30:00Z',
          cloud_updated_at: '2026-01-30T11:00:00Z',
          local_data: {
            content: 'This is a locally edited message',
            role: 'user',
            is_edited: true,
          },
          cloud_data: {
            content: 'This is a cloud-edited message',
            role: 'user',
            is_edited: true,
            extra_field: 'cloud_only',
          },
        },
      ],
      record_conflict_count: 1,
    };

    setState((prev) => ({
      ...prev,
      isDetecting: false,
      conflicts: mockConflicts,
      localManifestJson: JSON.stringify({ mock: true }),
      error: null,
    }));

    return mockConflicts;
  }, []);

  /**
   * 清除错误
   */
  const clearError = useCallback(() => {
    setState((prev) => ({
      ...prev,
      error: null,
    }));
  }, []);

  /**
   * 重置状态
   */
  const reset = useCallback(() => {
    setState({
      isDetecting: false,
      isResolving: false,
      conflicts: null,
      syncStatus: null,
      localManifestJson: null,
      cloudManifestJson: null,
      error: null,
      lastResult: null,
    });
  }, []);

  return {
    ...state,
    getSyncStatus,
    detectConflicts,
    resolveRecordConflict,
    loadRecordConflicts,
    detectConflictsMock,
    clearError,
    reset,
  };
}

export default useConflictResolution;
