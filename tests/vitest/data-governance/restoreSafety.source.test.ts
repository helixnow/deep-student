import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'src/components/DataImportExport.tsx'),
  'utf8',
);

describe('DataImportExport restore safety contract', () => {
  it('maps the VFS full selection to important and includes its assets', () => {
    expect(source).toMatch(
      /tier === 'vfs_full'\)\s*\{\s*mapped\.add\('important'\)/,
    );
    expect(source).toContain(
      "exportBackupTiers.includes('large_files') || exportBackupTiers.includes('vfs_full')",
    );
  });

  it('keeps the frontend write barrier after a restart-required restore', () => {
    expect(source).toContain(
      "requireMaintenanceRestart(t('common:maintenance.recovery_required'))",
    );
    expect(source).toContain('if (!restoreRequiresRestart) {');
    expect(source).toContain(
      'if (maintenanceModeEntered && !restoreRequiresRestart) {',
    );
  });
});
