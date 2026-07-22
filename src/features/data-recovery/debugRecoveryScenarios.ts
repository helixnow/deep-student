import type { StartupComponentIssue } from '@/types/dataGovernance';
import type { StartupRecoveryStatus } from './dataRecoveryApi';

export type RecoveryDebugScenario =
  | 'startup-conflict'
  | 'startup-preflight-failure'
  | 'core-migration-failure';

const DEBUG_SCENARIO_KEY = 'deep-student.debug-recovery-scenario';

export function setRecoveryDebugScenario(scenario: RecoveryDebugScenario): void {
  if (!import.meta.env.DEV) return;
  try {
    sessionStorage.setItem(DEBUG_SCENARIO_KEY, scenario);
  } catch {
    // Debug previews remain optional when webview storage is unavailable.
  }
}

export function getRecoveryDebugScenario(): RecoveryDebugScenario | null {
  if (!import.meta.env.DEV) return null;
  try {
    const scenario = sessionStorage.getItem(DEBUG_SCENARIO_KEY);
    return scenario === 'startup-conflict'
      || scenario === 'startup-preflight-failure'
      || scenario === 'core-migration-failure'
      ? scenario
      : null;
  } catch {
    return null;
  }
}

export function clearRecoveryDebugScenario(): void {
  try {
    sessionStorage.removeItem(DEBUG_SCENARIO_KEY);
  } catch {
    // Nothing to clear.
  }
}

const candidate = (
  id: 'legacy' | 'slotA' | 'slotB',
  options: {
    hasData: boolean;
    databases: string[];
    validCoreDatabases: string[];
    sizeBytes: number;
    recommended?: boolean;
    modifiedAt?: string | null;
  },
) => ({
  id,
  has_data: options.hasData,
  has_database: options.databases.length > 0,
  size_bytes: options.sizeBytes,
  latest_modified_at: options.modifiedAt ?? null,
  database_files: options.databases,
  core_database_files: options.databases.filter((database) =>
    ['mistakes.db', 'chat_v2.db', 'llm_usage.db', 'databases/vfs.db'].includes(database)),
  valid_core_database_files: options.validCoreDatabases,
  selectable: options.validCoreDatabases.length > 0,
  selection_block_reason:
    options.validCoreDatabases.length > 0 ? null : 'No valid core database',
  recommended: Boolean(options.recommended),
  recommendation_reason: options.recommended ? 'state.json points to this timeline' : null,
});

export function createStartupConflictDebugStatus(): StartupRecoveryStatus {
  return {
    recovery_required: true,
    incident: {
      id: 'debug-startup-conflict',
      kind: 'legacy_root_vs_slots',
      created_at: new Date().toISOString(),
      status: 'awaiting_selection',
      reason: 'Debug preview: multiple data timelines were detected',
      quarantined_entry_count: 6,
      selected_candidate: null,
      resolved_at: null,
      recovery_error: null,
      failed_operation: null,
      retry_requires_restart: false,
      candidates: [
        candidate('legacy', {
          hasData: true,
          databases: ['mistakes.db', 'chat_v2.db'],
          validCoreDatabases: ['mistakes.db', 'chat_v2.db'],
          sizeBytes: 148_897_792,
          modifiedAt: '2026-07-20T12:26:00Z',
        }),
        candidate('slotA', {
          hasData: true,
          databases: ['cache.db'],
          validCoreDatabases: [],
          sizeBytes: 3_145_728,
          modifiedAt: '2026-07-18T08:15:00Z',
        }),
        candidate('slotB', {
          hasData: true,
          databases: ['mistakes.db', 'chat_v2.db', 'llm_usage.db', 'databases/vfs.db'],
          validCoreDatabases: [
            'mistakes.db',
            'chat_v2.db',
            'llm_usage.db',
            'databases/vfs.db',
          ],
          sizeBytes: 326_107_136,
          recommended: true,
          modifiedAt: '2026-07-21T06:42:00Z',
        }),
      ],
    },
  };
}

export function createStartupPreflightFailureDebugStatus(): StartupRecoveryStatus {
  return {
    recovery_required: true,
    incident: {
      id: 'debug-startup-preflight-failure',
      kind: 'startup_preflight_failure',
      created_at: new Date().toISOString(),
      status: 'failed',
      reason: 'Debug preview: incident manifest could not be read',
      quarantined_entry_count: 0,
      selected_candidate: null,
      resolved_at: null,
      recovery_error:
        '读取恢复事件清单失败：manifest.json checksum mismatch（调试预览，不影响真实数据）',
      failed_operation: 'startup_preflight',
      retry_requires_restart: false,
      candidates: [],
    },
  };
}

export function createCoreMigrationFailureDebugIssues(): StartupComponentIssue[] {
  return [
    {
      component: 'vfs',
      status: 'blocked',
      reason:
        'VFS schema migration failed and the trusted startup snapshot could not be restored.',
      dependency: null,
    },
    {
      component: 'mistakes',
      status: 'blocked',
      reason: 'Skipped because dependency vfs is blocked.',
      dependency: 'vfs',
    },
    {
      component: 'chat_v2',
      status: 'blocked',
      reason: 'Skipped because dependency vfs is blocked.',
      dependency: 'vfs',
    },
    {
      component: 'llm_usage',
      status: 'healthy',
      reason: null,
      dependency: null,
    },
  ];
}

export function createPartialDegradationDebugIssues(): StartupComponentIssue[] {
  return [
    { component: 'vfs', status: 'healthy', reason: null, dependency: null },
    { component: 'mistakes', status: 'healthy', reason: null, dependency: null },
    {
      component: 'chat_v2',
      status: 'blocked',
      reason:
        'Chat V2 migration failed. Notes, question bank, VFS, and usage statistics remain available.',
      dependency: null,
    },
    { component: 'llm_usage', status: 'healthy', reason: null, dependency: null },
  ];
}
