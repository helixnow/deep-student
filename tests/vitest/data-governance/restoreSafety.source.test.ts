import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const governanceSource = readFileSync(
  resolve(process.cwd(), 'src/features/settings/components/DataGovernanceDashboard.tsx'),
  'utf8',
);
const dataGatewaySource = readFileSync(
  resolve(process.cwd(), 'src/components/DataImportExport.tsx'),
  'utf8',
);

describe('DataGovernance restore safety & DataImportExport consolidation contract', () => {
  it('routes standalone data-management backup/sync actions to DataGovernanceDashboard instead of duplicating legacy ZIP restore', () => {
    expect(dataGatewaySource).toContain("openDataGovernanceSettings('backup')");
    expect(dataGatewaySource).toContain("openDataGovernanceSettings('sync')");
    expect(dataGatewaySource).not.toContain('importConversationSnapshot');
  });

  it('keeps the frontend write barrier after a restart-required restore in DataGovernanceDashboard', () => {
    expect(governanceSource).toContain(
      "requireMaintenanceRestart(t('common:maintenance.recovery_required'))",
    );
    expect(governanceSource).toContain('cloudApi.isImportedArchiveSlotRestorable(stats)');
    expect(governanceSource).toContain('if (event.result?.requires_restart) {');
  });
});
