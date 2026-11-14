import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  RECOVERY_DIR,
  STARTUP_RECOVERY_EXPORT_STAGING_DIR,
  exportIncidentZip,
  purgeStaleRecoveryExportStaging,
  removeStagedRecoveryExport,
  startupRecoveryExportStagingPath,
} from '../recovery-export.ts';

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-recovery-export-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('recovery_export_staging_stays_outside_incidents_and_purges_stale_files', async () => {
  const base = tmp();
  const incidentDir = path.join(base, RECOVERY_DIR, 'incidents', 'incident-1');
  fs.mkdirSync(incidentDir, { recursive: true });
  fs.writeFileSync(path.join(incidentDir, 'manifest.json'), '{}');

  const staged = startupRecoveryExportStagingPath(base, 'zip');
  expect(staged.startsWith(path.join(base, RECOVERY_DIR, STARTUP_RECOVERY_EXPORT_STAGING_DIR))).toBe(true);
  expect(staged.startsWith(path.join(base, RECOVERY_DIR, 'incidents'))).toBe(false);
  expect(path.extname(staged)).toBe('.zip');

  await exportIncidentZip(incidentDir, staged);
  expect(fs.statSync(staged).isFile()).toBe(true);
  removeStagedRecoveryExport(staged);
  expect(fs.existsSync(staged)).toBe(false);
  expect(fs.existsSync(`${staged}.partial`)).toBe(false);

  const stagingDir = path.dirname(staged);
  const leftover = path.join(stagingDir, 'leftover.zip');
  fs.writeFileSync(leftover, 'stale');
  purgeStaleRecoveryExportStaging(stagingDir, 3600 * 1000);
  expect(fs.existsSync(leftover)).toBe(true);

  const old = new Date(Date.now() - 7200 * 1000);
  fs.utimesSync(leftover, old, old);
  purgeStaleRecoveryExportStaging(stagingDir, 3600 * 1000);
  expect(fs.existsSync(leftover)).toBe(false);
});
