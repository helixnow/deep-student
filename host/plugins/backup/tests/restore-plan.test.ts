import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import {
  assertNoUnconsumedCompleteDomains, newManifest, persistentDomainRegistry,
  updateCoverage, type BackupManifest,
} from '../src/manifest.ts';
import { consumeCompleteDomains, RESTORE_PENDING_TRUST_DIR_NAME } from '../src/restore-plan.ts';
import { sha256 } from './helpers.ts';

const tempDirs: string[] = [];
afterEach(() => { tempDirs.length = 0; });
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function addFile(manifest: BackupManifest, backupDir: string, archivePath: string, bytes: string | Uint8Array): void {
  const absolute = join(backupDir, archivePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, bytes);
  const data = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes);
  manifest.files.push({ path: archivePath, size: data.length, sha256: sha256(data) });
}

function baseManifest(): BackupManifest {
  const manifest = newManifest('0.0.0-test');
  manifest.backup_id = 'restore-plan-fixture';
  for (const spec of persistentDomainRegistry()) updateCoverage(manifest, spec.id, 'absent', []);
  return manifest;
}

describe('restore_plan.rs', () => {
  it('consume_restores_persistent_settings_and_reports_every_ledger_domain', async () => {
    const backupDir = temp('dstu-plan-backup-');
    const target = temp('dstu-plan-target-');
    const appRoot = temp('dstu-plan-app-');
    const manifest = baseManifest();
    addFile(manifest, backupDir, 'vfs.db', 'primary-db');
    addFile(manifest, backupDir, 'persistent/webview_settings.json', '{"theme":"dark"}');
    addFile(manifest, backupDir, 'persistent/custom_grading_modes.json', '{"modes":[]}');
    updateCoverage(manifest, 'database:vfs', 'complete', ['vfs.db']);
    updateCoverage(manifest, 'webview-settings', 'complete', ['persistent/webview_settings.json']);
    updateCoverage(manifest, 'custom-grading-modes', 'complete', ['persistent/custom_grading_modes.json']);
    mkdirSync(join(target, 'databases'), { recursive: true });
    writeFileSync(join(target, 'databases', 'vfs.db'), 'primary-db');

    const reports = await consumeCompleteDomains({} as Context, manifest, backupDir, target, appRoot);
    const ledger = manifest.coverage!;
    for (const domainId of Object.keys(ledger.domains)) {
      expect(reports.some(report => report.domain_id === domainId), `missing report for ${domainId}`).toBe(true);
    }
    for (const [domainId, targetName, expected] of [
      ['webview-settings', 'webview_settings.json', '{"theme":"dark"}'],
      ['custom-grading-modes', 'custom_grading_modes.json', '{"modes":[]}'],
    ] as const) {
      const report = reports.find(candidate => candidate.domain_id === domainId)!;
      expect(report.state).toBe('restored');
      expect(report.restored_files).toBe(1);
      expect(readFileSync(join(target, targetName), 'utf8')).toBe(expected);
    }
    const vfs = reports.find(report => report.domain_id === 'database:vfs')!;
    expect(vfs.state).toBe('restored');
    const workspaces = reports.find(report => report.domain_id === 'workspaces-root')!;
    expect(workspaces.state).toBe('skipped_absent');
    expect(reports.every(report => report.state !== 'failed')).toBe(true);
    expect(() => assertNoUnconsumedCompleteDomains(manifest, reports.map(report => report.domain_id))).not.toThrow();
  });

  it('untrusted_user_skills_are_quarantined_not_written_to_restore_target', async () => {
    const backupDir = temp('dstu-plan-skill-backup-');
    const target = temp('dstu-plan-skill-target-');
    const appRoot = temp('dstu-plan-skill-app-');
    const manifest = baseManifest();
    const skillRelative = 'persistent/user_skills/demo/SKILL.md';
    addFile(manifest, backupDir, skillRelative, '# demo skill\nrm -rf nothing\n');
    updateCoverage(manifest, 'user-skills', 'complete', [skillRelative]);

    const reports = await consumeCompleteDomains({} as Context, manifest, backupDir, target, appRoot);
    const skills = reports.find(report => report.domain_id === 'user-skills')!;
    expect(skills.state).toBe('isolated_pending_trust');
    expect(skills.code).toBe('E_RESTORE_UNTRUSTED_ISOLATED');
    const quarantined = join(target, RESTORE_PENDING_TRUST_DIR_NAME, 'user-skills', skillRelative);
    expect(readFileSync(quarantined, 'utf8')).toBe('# demo skill\nrm -rf nothing\n');
    expect(existsSync(join(target, 'persistent'))).toBe(false);
    expect(existsSync(join(target, '.deep-student'))).toBe(false);
    expect(existsSync(join(target, 'skills'))).toBe(false);
  });

  it('unconsumed_complete_domain_fails_with_stable_code', () => {
    const backupDir = temp('dstu-plan-unconsumed-backup-');
    const manifest = baseManifest();
    addFile(manifest, backupDir, 'persistent/webview_settings.json', '{"theme":"dark"}');
    updateCoverage(manifest, 'webview-settings', 'complete', ['persistent/webview_settings.json']);
    const consumed = Object.entries(manifest.coverage!.domains)
      .filter(([, evidence]) => evidence.status === 'complete')
      .map(([domainId]) => domainId);
    expect(() => assertNoUnconsumedCompleteDomains(manifest, consumed)).not.toThrow();
    const dropped = consumed.pop()!;
    let message = '';
    try { assertNoUnconsumedCompleteDomains(manifest, consumed); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain('E_RESTORE_DOMAIN_UNCONSUMED');
    expect(message).toContain(dropped);
  });

  it('primary_domain_missing_from_slot_is_reported_unconsumed', async () => {
    const backupDir = temp('dstu-plan-missing-backup-');
    const target = temp('dstu-plan-missing-target-');
    const appRoot = temp('dstu-plan-missing-app-');
    const manifest = baseManifest();
    addFile(manifest, backupDir, 'vfs.db', 'primary-db');
    updateCoverage(manifest, 'database:vfs', 'complete', ['vfs.db']);
    const reports = await consumeCompleteDomains({} as Context, manifest, backupDir, target, appRoot);
    const vfs = reports.find(report => report.domain_id === 'database:vfs')!;
    expect(vfs.state).toBe('failed');
    expect(vfs.code).toBe('E_RESTORE_DOMAIN_UNCONSUMED');
    expect(vfs.detail).toContain('E_RESTORE_DOMAIN_UNCONSUMED');
  });
});
