import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { backupAndExportZip } from '@/api/dataGovernance';

describe('backupAndExportZip API', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('invokes unified command with expected payload', async () => {
    mockInvoke.mockResolvedValue({
      job_id: 'job-1',
      kind: 'export',
      status: 'queued',
      message: 'ok',
    });

    await backupAndExportZip(
      '/tmp/export.zip',
      6,
      true,
      true,
      ['core', 'important'],
      true,
      ['images'],
    );

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('data_governance_backup_and_export_zip', {
      output_path: '/tmp/export.zip',
      compression_level: 6,
      add_to_backup_list: true,
      use_tiered: true,
      tiers: ['core', 'important'],
      include_assets: true,
      asset_types: ['images'],
    });
  });
});
