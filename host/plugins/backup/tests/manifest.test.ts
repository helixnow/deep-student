import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import {
  archivePathRequiresExplicitTrust, classifyRecoveryKind, domainRestorePlan, loadManifest, markFull,
  newCoverageLedger, newManifest, parseManifest, persistentDomainRegistry, saveManifest,
  sha256File, validateLegacyCandidateForUpgrade, type BackupManifest,
} from '../src/manifest.ts';
import { listBackups, resolveExistingBackupFile } from '../src/backup-manager.ts';
import { createBackupHost, createDatabaseFile, hostBackupRoot, partialManifest, waitForJob, writeBackup } from './helpers.ts';

function partial(): BackupManifest {
  return partialManifest('manifest-test', { files: { 'persistent/a.json': 'a' } });
}

it('test_manifest_serialization', () => {
  const manifest = partial();
  const parsed = parseManifest(JSON.parse(JSON.stringify(manifest)));
  expect(parsed.version).toBe('3.0.0');
  expect(parsed.backup_id).toBe('manifest-test');
  expect(parsed.snapshot_kind).toBe('partial_overlay');
  expect(parsed.key_policy).toBe('excluded_portable');
  expect(parsed.files).toEqual(manifest.files);
  expect(parsed.coverage?.version).toBe(1);
});

it('test_manifest_save_and_load', () => {
  const root = mkdtempSync(join(tmpdir(), 'dstu-manifest-'));
  const path = join(root, 'manifest.json');
  const manifest = partial();
  saveManifest(path, manifest);
  const loaded = loadManifest(path);
  expect(loaded.backup_id).toBe(manifest.backup_id);
  expect(loaded.files).toEqual(manifest.files);
  expect(loaded.coverage).toEqual(manifest.coverage);
});

it('test_calculate_file_sha256', () => {
  const root = mkdtempSync(join(tmpdir(), 'dstu-hash-'));
  const path = join(root, 'data.bin');
  const content = Buffer.from('hello backup');
  writeFileSync(path, content);
  expect(sha256File(path, content.length)).toBe(createHash('sha256').update(content).digest('hex'));
  expect(() => sha256File(path, content.length + 1)).toThrow('文件在校验期间大小变化');
});

it('test_list_backups_overrides_manifest_backup_id_with_dir_name', () => {
  // Rust mod.rs:6736-6755：唯一目录名与 manifest.backup_id 不一致。
  const root = mkdtempSync(join(tmpdir(), 'dstu-list-'));
  const renamed = join(root, '20260207_120000_incr');
  mkdirSync(renamed);
  writeFileSync(join(renamed, 'manifest.json'), JSON.stringify({ ...partial(), backup_id: 'WRONG_ID' }));
  const backups = listBackups(root);
  expect(backups).toHaveLength(1);
  expect(backups[0]!.backup_id).toBe('20260207_120000_incr');
});

it('test_verify_rejects_manifest_file_path_traversal_before_reading', () => {
  const root = mkdtempSync(join(tmpdir(), 'dstu-path-'));
  expect(() => resolveExistingBackupFile(root, '../escape')).toThrow('备份清单包含不安全路径');
  expect(() => resolveExistingBackupFile(root, 'safe/../../escape')).toThrow('备份清单包含不安全路径');
});

it('test_verify_rejects_symlinked_manifest_file', () => {
  const root = mkdtempSync(join(tmpdir(), 'dstu-symlink-'));
  const backup = join(root, 'backup');
  mkdirSync(backup);
  writeFileSync(join(root, 'outside.txt'), 'outside');
  symlinkSync(join(root, 'outside.txt'), join(backup, 'linked.txt'));
  expect(() => resolveExistingBackupFile(backup, 'linked.txt')).toThrow('备份路径不允许符号链接');
});

it('legacy_v1_v2_manifests_load_as_candidates_without_coverage', () => {
  const legacy = {
    version: '2.0.0', app_version: '0.0.0-test', created_at: '2026-01-01T00:00:00Z',
    platform: 'macos', schema_versions: {}, files: [], is_incremental: false,
    incremental_base: null, backup_id: 'legacy-id',
  };
  const parsed = parseManifest(legacy);
  expect(parsed.snapshot_kind).toBe('legacy_candidate');
  expect(parsed.key_policy).toBe('legacy_unknown');
  expect(parsed.coverage).toBeUndefined();
});

it('manifest_v3_without_coverage_is_rejected_instead_of_downgraded', () => {
  expect(() => parseManifest({
    version: '3.0.0', app_version: '0.0.0-test', created_at: '2026-01-01T00:00:00Z',
    platform: 'macos', schema_versions: {}, files: [], is_incremental: false,
    incremental_base: null, backup_id: 'v3-id', snapshot_kind: 'full',
  })).toThrow('manifest v3 缺少 coverage ledger');
});

it('persistent_registry_marks_user_skills_untrusted_executable', () => {
  const spec = persistentDomainRegistry().find(domain => domain.id === 'user-skills');
  expect(spec).toMatchObject({
    archive_root: 'persistent/user_skills',
    restore_target: '~/.deep-student/skills',
    executable: true,
    optional: true,
    encrypted: true,
    restore_trust: 'untrusted_executable',
    restore_scope: 'user_home',
  });
});

it('executable_agent_assets_require_explicit_restore_trust', () => {
  expect(archivePathRequiresExplicitTrust('assets/workspaces/agents/a.md')).toBe(true);
  expect(archivePathRequiresExplicitTrust('persistent/user_skills/a.md')).toBe(true);
  expect(archivePathRequiresExplicitTrust('persistent/webview_settings.json')).toBe(false);
});

it('active_data_space_settings_are_manifested_with_restore_scope', async () => {
  const registry = persistentDomainRegistry();
  expect(registry.find(domain => domain.id === 'webview-settings')).toMatchObject({
    archive_root: 'persistent/webview_settings.json', restore_scope: 'active_data_space',
  });
  expect(registry.find(domain => domain.id === 'custom-grading-modes')).toMatchObject({
    archive_root: 'persistent/custom_grading_modes.json', restore_scope: 'active_data_space',
  });
  expect(registry.find(domain => domain.id === 'crypto')?.restore_scope).toBe('application_data');

  // Rust backup/mod.rs:7611-7635 断言的是实际备份的恢复计划，不只是静态注册目录。
  let storage!: StorageServiceImpl;
  const { host } = await createBackupHost({
    storageFactory: dataDir => {
      storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
      return storage;
    },
  });
  try {
    const active = storage.locations.activeDir;
    for (const name of ['mistakes.db', 'chat_v2.db', 'llm_usage.db', 'databases/vfs.db']) {
      createDatabaseFile(join(active, name));
    }
    writeFileSync(join(active, 'webview_settings.json'), '{"theme":"dark"}');
    writeFileSync(join(active, 'custom_grading_modes.json'), '{"modes":[]}');
    const started = await host.invoke('data_governance_run_backup', { includeAssets: true }) as { job_id: string };
    const job = await waitForJob(host, started.job_id);
    expect(job.status, String(job.error ?? job.message ?? '')).toBe('completed');
    const result = job.result as { output_path: string };
    const manifest = loadManifest(join(hostBackupRoot(host), result.output_path, 'manifest.json'));
    for (const domain of ['webview-settings', 'custom-grading-modes']) {
      const plan = domainRestorePlan(manifest, domain)!;
      expect(plan.status, domain).toBe('complete');
      expect(plan.restore_scope, domain).toBe('active_data_space');
      expect(plan.files, domain).toHaveLength(1);
      expect(plan.files[0]!.sha256?.length, domain).toBe(64);
    }
  } finally {
    await host.dispose();
    storage.dispose();
  }
});

it('full_label_is_not_synthesized_without_coverage_evidence', () => {
  const manifest = newManifest('test');
  expect(() => markFull(manifest)).toThrow();
  expect(manifest.snapshot_kind).toBe('partial_overlay');
  expect(Object.values(manifest.coverage!.domains).every(domain => domain.status === 'excluded')).toBe(true);
  expect(classifyRecoveryKind(manifest)).toEqual({ kind: 'partial_archive', restorable: false });
});

it('empty_legacy_candidate_cannot_pass_upgrade_gate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dstu-legacy-empty-'));
  const path = join(dir, 'manifest.json');
  writeFileSync(path, JSON.stringify({
    version: '2.0.0',
    app_version: 'legacy',
    created_at: '2026-01-01T00:00:00Z',
    platform: 'test',
    schema_versions: {},
    files: [],
    is_incremental: false,
    incremental_base: null,
    backup_id: 'empty_legacy',
    snapshot_kind: 'full',
    snapshot_epoch: 'legacy',
    required_components: [],
    included_components: [],
    key_policy: 'not_present',
  }));
  const manifest = loadManifest(path);
  expect(() => validateLegacyCandidateForUpgrade(manifest)).toThrow();
  expect(manifest.snapshot_kind).toBe('legacy_candidate');
});

it('legacy_upgrade_rejects_unclassified_persistent_files', () => {
  const manifest = newManifest('legacy');
  manifest.version = '2.0.0';
  manifest.snapshot_kind = 'legacy_candidate';
  manifest.coverage = undefined;
  manifest.key_policy = 'legacy_unknown';
  for (const database of ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const) {
    manifest.files.push({
      path: `${database}.db`, size: 1, sha256: 'a'.repeat(64), database_id: database,
    });
  }
  manifest.files.push({
    path: 'persistent/unregistered.bin', size: 1, sha256: 'b'.repeat(64),
  });
  expect(() => validateLegacyCandidateForUpgrade(manifest)).toThrow('未分类');
});

it('new_coverage_ledger_contains_every_registered_domain', () => {
  const coverage = newCoverageLedger();
  for (const spec of persistentDomainRegistry()) {
    expect(coverage.domains[spec.id]).toMatchObject({
      status: 'excluded', paths: [], file_count: 0, total_size: 0,
    });
  }
});
