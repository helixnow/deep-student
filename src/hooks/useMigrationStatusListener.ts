/**
 * 迁移状态监听 Hook
 *
 * 监听后端数据治理系统的迁移状态事件，并在启动时显示相应通知。
 * - 迁移成功：静默处理（可选显示成功通知）
 * - 迁移有警告：显示警告通知
 * - 迁移失败：显示错误通知，提示用户可能需要手动干预
 *
 * 🔧 修复事件时序问题：
 * 由于后端在 setup 阶段发送事件，可能早于前端监听器设置，
 * 因此在设置监听器后主动查询一次迁移状态。
 */

import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import i18n from '@/i18n';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { MigrationStatusResponse } from '@/types/dataGovernance';
import { useSystemStatusStore } from '@/stores/systemStatusStore';

/** 迁移状态事件 payload 类型 */
interface MigrationStatusPayload {
  success: boolean;
  global_version?: number;
  migrations_applied?: number;
  duration_ms?: number;
  warnings?: string[];
  has_warnings?: boolean;
  error?: string;
  degraded_mode?: boolean;
}

/** 迁移状态事件名称 */
const MIGRATION_STATUS_EVENT = 'data-governance-migration-status';

const getPayloadDedupeKey = (payload: MigrationStatusPayload): string => {
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.map((warning) => warning.trim()).filter(Boolean)
    : [];

  return JSON.stringify({
    success: payload.success,
    global_version: payload.global_version ?? null,
    migrations_applied: payload.migrations_applied ?? null,
    has_warnings: Boolean(payload.has_warnings && warnings.length > 0),
    warnings,
    error: payload.error ?? null,
    degraded_mode: Boolean(payload.degraded_mode),
  });
};

/**
 * 监听数据治理迁移状态的 Hook
 *
 * 在应用启动时自动监听后端发送的迁移状态事件，
 * 并根据迁移结果显示相应的全局通知。
 *
 * @param options 配置选项
 * @param options.showSuccessNotification 是否在迁移成功时显示通知（默认 false）
 */
export function useMigrationStatusListener(options?: {
  showSuccessNotification?: boolean;
}): void {
  const { showSuccessNotification = false } = options ?? {};
  const lastPayloadDedupeKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;

    const { showMigrationStatus, clearMigrationStatus } = useSystemStatusStore.getState();

    // 处理迁移状态的通用函数
    const handleMigrationStatus = (payload: MigrationStatusPayload) => {
      const payloadDedupeKey = getPayloadDedupeKey(payload);
      if (lastPayloadDedupeKeyRef.current === payloadDedupeKey) {
        return;
      }
      lastPayloadDedupeKeyRef.current = payloadDedupeKey;

      const warningList = payload.warnings?.map((warning) => warning.trim()).filter(Boolean) ?? [];
      const warningText = warningList.join('\n');
      const migrationFailedTitle = i18n.t('data:governance.listener_migration_failed_title');
      const unknownErrorText = i18n.t('data:governance.listener_unknown_error');
      const warningTitle = i18n.t('data:governance.listener_migration_warning_title');

      if (!payload.success) {
        showMigrationStatus({
          level: 'error',
          message: migrationFailedTitle,
          details: payload.error || unknownErrorText,
        });

        const failureMessageKey = payload.degraded_mode
          ? 'data:governance.listener_migration_failed_message'
          : 'data:governance.listener_migration_failed_message_no_degrade';

        showGlobalNotification(
          'error',
          i18n.t(failureMessageKey, {
            error: payload.error || unknownErrorText,
          })
        );

        console.error('[MigrationStatus] Migration failed:', payload.error);
      } else if (payload.has_warnings && warningList.length > 0) {
        showMigrationStatus({
          level: 'warning',
          message: warningTitle,
          details: warningText,
        });

        showGlobalNotification(
          'warning',
          i18n.t('data:governance.listener_migration_warning_message', {
            warnings: warningText,
          })
        );

        console.warn('[MigrationStatus] Migration completed with warnings:', warningList);
      } else if (showSuccessNotification && payload.migrations_applied && payload.migrations_applied > 0) {
        showGlobalNotification(
          'success',
          i18n.t('data:governance.listener_migration_success_message', {
            version: payload.global_version,
            count: payload.migrations_applied,
          })
        );

        console.log(
          '[MigrationStatus] Migration succeeded:',
          `version=${payload.global_version}, applied=${payload.migrations_applied}`
        );
      } else {
        clearMigrationStatus();

        console.log(
          '[MigrationStatus] Database status OK:',
          `version=${payload.global_version}`
        );
      }
    };

    const setupListener = async () => {
      try {
        // 1. 设置事件监听器（用于接收后续的迁移状态变更）
        const nextUnlisten = await listen<MigrationStatusPayload>(
          MIGRATION_STATUS_EVENT,
          (event) => handleMigrationStatus(event.payload)
        );
        if (disposed) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;

        // 2. 主动查询一次迁移状态，兜底 setup 期早发事件
        try {
          const status = await invoke<MigrationStatusResponse>('data_governance_get_migration_status');

          // 仅在尚未收到事件时应用兜底结果，避免覆盖真实事件状态
          if (lastPayloadDedupeKeyRef.current == null) {
            if (status.has_pending_migrations && status.last_error) {
              handleMigrationStatus({
                success: false,
                error: status.last_error,
                global_version: Number(status.global_version),
                degraded_mode: false,
              });
            } else if (status.has_pending_migrations) {
              handleMigrationStatus({
                success: true,
                has_warnings: true,
                warnings: [
                  i18n.t('data:governance.listener_pending_migration_warning', {
                    count: status.pending_migrations_total,
                  }),
                ],
                global_version: Number(status.global_version),
              });
            } else {
              handleMigrationStatus({
                success: true,
                global_version: Number(status.global_version),
                has_warnings: false,
                warnings: [],
              });
            }
          }
        } catch (err: unknown) {
          console.warn('[MigrationStatus] Failed to query migration status:', err);
        }
      } catch (err: unknown) {
        console.warn('[MigrationStatus] Failed to setup migration status listener:', err);
      }
    };

    void setupListener();

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [showSuccessNotification]);
}

export default useMigrationStatusListener;
