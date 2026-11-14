/**
 * C1 cross-language consistency (`src-tauri/tests/c1_cross_lang_consistency.rs`).
 *
 * These tests pin the user-facing English contract shared by the browser
 * settings gates and the backup/data-governance messages. They consume the
 * owning lanes' shipped implementations; nothing here re-implements them.
 */
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { assertSettingsGatesOpen } from '../../browser/api.ts';
// boundary-allow cross-plugin-impl: C1 cross-lane test drives L21's shipped backup job manager; backup@1 only publishes the interface, and a test-only export would modify L21.
import backupPlugin from '../../backup/index.ts';
// boundary-allow cross-plugin-impl: C1 asserts the exact English constant emitted by L21's job manager.
import { INCREMENTAL_BACKUP_DISABLED_MESSAGE } from '../../backup/src/jobs.ts';
// boundary-allow cross-plugin-impl: C1 asserts the data-governance wording matches the job manager constant.
import { INCREMENTAL_BACKUP_REMOVED_MESSAGE } from '../../backup/src/manifest.ts';

describe('tests/c1_cross_lang_consistency.rs', () => {
  it('workbench_mode_missing_defaults_open_with_browser_child_on', () => {
    // assert_settings_gates_open settings half: missing key -> parent gate open
    // (together with an explicit child gate).
    expect(assertSettingsGatesOpen(null, 'true')).toBeNull();
    expect(assertSettingsGatesOpen('', 'true')).toBeNull();
    expect(assertSettingsGatesOpen('true', 'true')).toBeNull();
  });

  it('workbench_mode_explicit_false_closes_even_when_browser_child_on', () => {
    expect(assertSettingsGatesOpen('false', 'true'))
      .toBe('browser disabled: desktop.workbenchMode is off');
    expect(assertSettingsGatesOpen('  false  ', 'true')).not.toBeNull();
  });

  it('browser_child_gate_remains_opt_in_when_parent_defaults_open', () => {
    expect(assertSettingsGatesOpen(null, null))
      .toBe('browser disabled: desktop.workbenchBrowserEnabled is off');
    expect(assertSettingsGatesOpen(null, 'false')).not.toBeNull();
  });

  it('incremental_backup_disabled_message_matches_data_governance_english', () => {
    expect(INCREMENTAL_BACKUP_DISABLED_MESSAGE)
      .toBe('Incremental backup has been removed; use full backup or cloud sync');
    expect(/^[\x00-\x7f]*$/.test(INCREMENTAL_BACKUP_DISABLED_MESSAGE)).toBe(true);
    expect(INCREMENTAL_BACKUP_DISABLED_MESSAGE).toBe(INCREMENTAL_BACKUP_REMOVED_MESSAGE);
  });

  it('set_params_rejects_incremental_job_with_english_removed_message', async () => {
    const host = await createTestHost({
      // settings/secrets 是为满足 backup 插件 inject 的最小占位。
      provide: { settings: {}, secrets: {} },
    });
    // backup 在 apply 末尾向真实 F3 storage 注册 startup finalizer；只用 locations
    // 的替身不满足 StorageService 生命周期合同（registerFinalizer 缺失）。
    const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
    host.ctx.provide('storage', storage);
    try {
      await host.install(backupPlugin);
      expect(storage.finalizerNames(), 'backup registers its startup finalizer during apply')
        .toContain('backup.restore-activation');
      const job = host.ctx.backup.jobs.createJob('export');
      job.setParams({
        backup_type: 'incremental',
        include_assets: false,
        include_checksums: false,
      });

      const summary = host.ctx.backup.jobs.getJob(job.job_id);
      expect(summary, 'job remains queryable after rejection').not.toBeNull();
      expect(summary!.status).toBe('failed');
      expect(summary!.phase).toBe('failed');

      const message = summary!.message;
      expect(message).toBe(INCREMENTAL_BACKUP_DISABLED_MESSAGE);
      expect(message).toContain('Incremental backup has been removed');
      expect(message!.includes('full backup') || message!.includes('cloud sync')).toBe(true);

      expect(summary!.result?.error).toBe(INCREMENTAL_BACKUP_DISABLED_MESSAGE);
      expect(job.isCancelled(), 'cancel flag must be set on rejection').toBe(true);
    } finally {
      await host.dispose();
      storage.dispose();
    }
  });
});
