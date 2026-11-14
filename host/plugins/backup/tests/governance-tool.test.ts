import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_SYNC_STRATEGIES, DataGovernanceToolExecutor, JOB_RECEIPT_TTL_MS, backupJobSummaryJson, ensureAllowedKeys,
  governanceError, optionalEnum, pagination, parseAssetTypes, rememberBackupJob, syncExecutionJson,
  wasAgentBackupJob,
  type GovernanceSyncExecution,
} from '../src/governance-tool.ts';

function syncResponse(overrides: Partial<GovernanceSyncExecution> = {}): GovernanceSyncExecution {
  return {
    success: true,
    direction: 'upload',
    changes_uploaded: 0,
    changes_downloaded: 0,
    conflicts_detected: 0,
    duration_ms: 10,
    device_id: 'not-returned',
    error_message: null,
    skipped_changes: 0,
    ...overrides,
  };
}

describe('chat_v2/tools/data_governance_executor.rs', () => {
  it('handles_only_governance_tools_with_expected_policy', () => {
    const executor = new DataGovernanceToolExecutor();
    for (const tool of [
      'builtin-backup_status',
      'builtin-backup_job_status',
      'builtin-backup_create',
      'builtin-sync_status',
      'builtin-sync_run',
    ]) {
      expect(executor.canHandle(tool), `must handle ${tool}`).toBe(true);
    }
    expect(executor.canHandle('builtin-backup_restore')).toBe(false);
    expect(executor.sensitivityLevel('builtin-backup_create')).toBe('high');
    expect(executor.sensitivityLevel('builtin-sync_run')).toBe('high');
    expect(executor.concurrencyClass('builtin-sync_status')).toBe('read_only');
    expect(executor.name()).toBe('DataGovernanceToolExecutor');
  });

  it('pagination_defaults_and_caps_at_twenty', () => {
    expect(pagination({})).toEqual([1, 20, 0]);
    expect(pagination({ page: 2, page_size: 20 })).toEqual([2, 20, 20]);
    expect(() => pagination({ page_size: 21 })).toThrow();
    expect(() => pagination({ page: 0 })).toThrow();
  });

  it('backup_create_rejects_incremental_and_unreviewed_asset_values', () => {
    const incremental = { backup_type: 'incremental' };
    expect(() => ensureAllowedKeys(incremental, ['include_assets', 'asset_types'])).toThrow();

    const withoutFlag = { asset_types: ['images'] };
    expect(() => parseAssetTypes(withoutFlag, false)).toThrow();

    const invalid = { asset_types: ['secrets'] };
    expect(() => parseAssetTypes(invalid, true)).toThrow();

    const valid = { asset_types: ['images', 'notes_assets'] };
    expect(parseAssetTypes(valid, true)).toEqual(['images', 'notes_assets']);
  });

  it('sync_args_reject_cloud_config_credentials_and_manual_policy', () => {
    for (const forbidden of ['cloud_config', 'credentials', 'token', 'password']) {
      const args: Record<string, unknown> = { direction: 'upload' };
      args[forbidden] = 'secret';
      expect(() => ensureAllowedKeys(args, ['direction', 'strategy'])).toThrow();
    }

    const manual = { strategy: 'manual' };
    expect(() => optionalEnum(manual, 'strategy', ALLOWED_SYNC_STRATEGIES)).toThrow();
  });

  it('skipped_or_warning_sync_is_never_reported_as_success', () => {
    const skipped = syncExecutionJson(syncResponse({
      success: true, direction: 'upload', changes_uploaded: 2, skipped_changes: 1,
    }), 'keep_latest');
    expect(skipped.success).toBe(false);
    expect(skipped.status).toBe('partial');
    expect(skipped.skipped_changes).toBe(1);
    expect(JSON.stringify(skipped)).not.toContain('not-returned');

    const warning = syncExecutionJson(syncResponse({
      success: true,
      direction: 'download',
      changes_downloaded: 1,
      error_message: 'one file was not copied',
    }), 'keep_latest');
    expect(warning.success).toBe(false);
    expect(warning.status).toBe('partial');
  });

  it('clean_sync_result_is_success_and_failure_without_effects_is_error', () => {
    const clean = syncExecutionJson(syncResponse({ direction: 'bidirectional' }), 'keep_latest');
    expect(clean.success).toBe(true);
    expect(clean.status).toBe('success');

    const failed = syncResponse({
      success: false, direction: 'upload', error_message: 'connection refused',
    });
    expect(() => syncExecutionJson(failed, 'keep_latest')).toThrow();
  });

  it('issued_job_receipt_distinguishes_expired_from_unknown', () => {
    const known = randomUUID();
    const unknown = randomUUID();
    const now = performance.now();
    rememberBackupJob(known, now);
    expect(wasAgentBackupJob(known, now)).toBe(true);
    expect(wasAgentBackupJob(unknown, now)).toBe(false);
  });

  it('default receipt lifetime does not follow forward or backward wall-clock adjustments', () => {
    const known = randomUUID();
    const epoch = 1_700_000_000_000;
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(epoch);
    try {
      rememberBackupJob(known);
      expect(wasAgentBackupJob(known)).toBe(true);
      wallClock.mockReturnValue(epoch + JOB_RECEIPT_TTL_MS + 1);
      expect(wasAgentBackupJob(known)).toBe(true);
      wallClock.mockReturnValue(epoch - JOB_RECEIPT_TTL_MS - 1);
      expect(wasAgentBackupJob(known)).toBe(true);
    } finally { wallClock.mockRestore(); }
  });

  it('receipt lifetime still expires at the 24-hour monotonic boundary', () => {
    const known = randomUUID();
    const now = 10_000;
    rememberBackupJob(known, now);
    expect(wasAgentBackupJob(known, now + JOB_RECEIPT_TTL_MS - 1)).toBe(true);
    expect(wasAgentBackupJob(known, now + JOB_RECEIPT_TTL_MS)).toBe(false);
  });

  it('governance_errors_are_bounded_and_structured', () => {
    const error = governanceError('TEST', '译'.repeat(2_100), 'hint', false);
    const parsed = JSON.parse(error) as Record<string, unknown>;
    expect(parsed.code).toBe('TEST');
    expect(Array.from(parsed.message as string)).toHaveLength(2_000);
    expect(parsed.retryable).toBe(false);
  });

  it('backup_job_summary_json_omits_kind_and_resumable_like_rust', () => {
    const output = backupJobSummaryJson({
      job_id: 'job-1',
      kind: 'export',
      status: 'completed',
      phase: 'completed',
      progress: 1,
      message: null,
      created_at: '2026-01-01T00:00:00+00:00',
      started_at: '2026-01-01T00:00:01+00:00',
      finished_at: undefined,
      result: {
        success: true,
        output_path: '/tmp/x',
        message: null,
        error: null,
        duration_ms: 5,
        requires_restart: false,
      },
      resumable: false,
    });
    expect(output).toEqual({
      job_id: 'job-1',
      status: 'completed',
      phase: 'completed',
      progress: 1,
      terminal: true,
      message: null,
      created_at: '2026-01-01T00:00:00+00:00',
      started_at: '2026-01-01T00:00:01+00:00',
      finished_at: null,
      result: { success: true, message: null, error: null, duration_ms: 5 },
      terminal_result_available: true,
    });
    expect(output).not.toHaveProperty('kind');
    expect(output).not.toHaveProperty('resumable');
  });
});
