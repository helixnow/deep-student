import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('cloud sync Phase 0 frontend guarantees', () => {
  const cloudStorageSection = readFileSync(
    resolve(process.cwd(), 'src/features/settings/components/CloudStorageSection.tsx'),
    'utf-8'
  );
  const syncSettingsSection = readFileSync(
    resolve(process.cwd(), 'src/features/settings/components/SyncSettingsSection.tsx'),
    'utf-8'
  );
  const cloudStorageApi = readFileSync(
    resolve(process.cwd(), 'src/utils/cloudStorageApi.ts'),
    'utf-8'
  );

  it('never persists FTP passwords in the safe localStorage config', () => {
    expect(cloudStorageSection).toContain('ftpPassword: ftpConfig.password || undefined');
    expect(cloudStorageSection).toContain("ftp: config.ftp ? { ...config.ftp, password: '' } : undefined");
    expect(cloudStorageSection).toContain("ftp: oldConfig.ftp ? { ...oldConfig.ftp, password: '' } : undefined");
    expect(cloudStorageSection).toContain('leakedCredentials.ftpPassword = config.ftp.password');
    expect(cloudStorageSection).toContain('credentials.ftpPassword = oldConfig.ftp.password');
  });

  it('hydrates FTP passwords only from secure storage', () => {
    const ftpBranchStart = cloudStorageApi.indexOf("if (safe.provider === 'ftp')");
    const ftpBranchEnd = cloudStorageApi.indexOf("  return {\n    ...safe,\n    s3:", ftpBranchStart);
    const ftpBranch = cloudStorageApi.slice(ftpBranchStart, ftpBranchEnd);

    expect(ftpBranchStart).toBeGreaterThan(-1);
    expect(ftpBranch).toContain('password: credentials?.ftpPassword ??');
    expect(ftpBranch).not.toContain('safe.ftp.password');
  });

  it('keeps FTP hidden for new configs unless the experimental flag or existing config is present', () => {
    expect(cloudStorageSection).toContain('VITE_ENABLE_EXPERIMENTAL_FTP_STORAGE');
    expect(cloudStorageSection).toContain('const shouldShowFtpOption = FTP_STORAGE_EXPERIMENTAL_ENABLED || hasStoredFtpConfig || provider ===');
    expect(cloudStorageSection).toContain('cloudStorage:ftp.experimentalWarning');
  });

  it('uses the sync command result, not only progress events, to decide success', () => {
    expect(syncSettingsSection).toContain('const result = await runSyncWithProgress');
    expect(syncSettingsSection).toContain('result.success && !result.error_message');
    expect(syncSettingsSection).toContain('result.skipped_changes');
    expect(syncSettingsSection).not.toContain('onComplete: () =>');
  });
});
