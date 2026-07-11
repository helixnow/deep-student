import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("cloud sync Phase 0 frontend guarantees", () => {
  const cloudStorageSection = readFileSync(
    resolve(
      process.cwd(),
      "src/features/settings/components/CloudStorageSection.tsx",
    ),
    "utf-8",
  );
  const syncSettingsSection = readFileSync(
    resolve(
      process.cwd(),
      "src/features/settings/components/SyncSettingsSection.tsx",
    ),
    "utf-8",
  );
  const cloudStorageApi = readFileSync(
    resolve(process.cwd(), "src/utils/cloudStorageApi.ts"),
    "utf-8",
  );
  const dataGovernanceApi = readFileSync(
    resolve(process.cwd(), "src/api/dataGovernance.ts"),
    "utf-8",
  );
  const dashboard = readFileSync(
    resolve(
      process.cwd(),
      "src/features/settings/components/DataGovernanceDashboard.tsx",
    ),
    "utf-8",
  );
  const backupTab = readFileSync(
    resolve(
      process.cwd(),
      "src/features/settings/components/data-governance/BackupTab.tsx",
    ),
    "utf-8",
  );
  const backupJobListener = readFileSync(
    resolve(process.cwd(), "src/hooks/useBackupJobListener.ts"),
    "utf-8",
  );
  const syncTab = readFileSync(
    resolve(
      process.cwd(),
      "src/features/settings/components/data-governance/SyncTab.tsx",
    ),
    "utf-8",
  );
  const syncConflictDialog = readFileSync(
    resolve(process.cwd(), "src/components/SyncConflictDialog.tsx"),
    "utf-8",
  );
  const tauriLib = readFileSync(
    resolve(process.cwd(), "src-tauri/src/lib.rs"),
    "utf-8",
  );

  it("never persists FTP passwords in the safe localStorage config", () => {
    expect(cloudStorageSection).toContain(
      "ftpPassword: ftpConfig.password || undefined",
    );
    expect(cloudStorageSection).toContain(
      "ftp: config.ftp ? { ...config.ftp, password: '' } : undefined",
    );
    expect(cloudStorageSection).toContain(
      "ftp: oldConfig.ftp ? { ...oldConfig.ftp, password: '' } : undefined",
    );
    expect(cloudStorageSection).toContain(
      "leakedCredentials.ftpPassword = config.ftp.password",
    );
    expect(cloudStorageSection).toContain(
      "credentials.ftpPassword = oldConfig.ftp.password",
    );
  });

  // [P0-3A] 2026-06-12 更新：前端不再回填明文凭据，敏感字段一律传空占位，
  // 由后端 hydrate_cloud_config 从系统安全存储补全（明文不过 IPC）。
  it("sends empty FTP password placeholders instead of hydrating plaintext in the frontend", () => {
    const ftpBranchStart = cloudStorageApi.indexOf(
      "if (safe.provider === 'ftp')",
    );
    const ftpBranchEnd = cloudStorageApi.indexOf(
      "  return {\n    ...safe,\n    s3:",
      ftpBranchStart,
    );
    const ftpBranch = cloudStorageApi.slice(ftpBranchStart, ftpBranchEnd);

    expect(ftpBranchStart).toBeGreaterThan(-1);
    expect(ftpBranch).toContain("password: ''");
    expect(ftpBranch).not.toContain("safe.ftp.password");
    expect(ftpBranch).not.toContain("ftpPassword");
  });

  it("keeps FTP hidden for new configs unless the experimental flag or existing config is present", () => {
    expect(cloudStorageSection).toContain(
      "VITE_ENABLE_EXPERIMENTAL_FTP_STORAGE",
    );
    expect(cloudStorageSection).toContain(
      "const shouldShowFtpOption = FTP_STORAGE_EXPERIMENTAL_ENABLED || hasStoredFtpConfig || provider ===",
    );
    expect(cloudStorageSection).toContain(
      "cloudStorage:ftp.experimentalWarning",
    );
  });

  it("uses the sync command result, not only progress events, to decide success", () => {
    expect(syncSettingsSection).toContain(
      "const result = await runSyncWithProgress",
    );
    expect(syncSettingsSection).toContain(
      "result.success && !result.error_message",
    );
    expect(syncSettingsSection).toContain("result.skipped_changes");
    expect(syncSettingsSection).not.toContain("onComplete: () =>");
  });

  it("fails closed for job business failures, polling timeouts, and prune gaps", () => {
    expect(cloudStorageSection).toContain("job.result?.success !== true");
    expect(cloudStorageSection).toContain("DataGovernanceApi.cancelBackup(jobId)");
    expect(backupJobListener).toContain("event.result?.success === true");
    expect(syncSettingsSection).toContain("DataGovernanceApi.detectPruneGap(cloudConfig)");
    expect(syncSettingsSection).toContain("let unlisten: (() => void) | null = null");
    expect(dashboard).not.toContain("detectPruneGap 检查失败（继续同步）");
    expect(dashboard).not.toContain("window.confirm(warnMsg)");
  });

  it("creates a full cloud snapshot and requires immediate restart after restore", () => {
    expect(cloudStorageSection).toContain("['core', 'important', 'rebuildable', 'large_assets']");
    expect(cloudStorageSection).toContain('Number.MAX_SAFE_INTEGER');
    expect(cloudStorageSection).toContain("await TauriAPI.restartApp()");
    expect(cloudStorageSection).not.toContain("cloudStorage:download.restartWhenReady");
    expect(backupTab).not.toContain("onRestartLater");
    expect(backupTab).not.toContain("data:governance.restart_later");
  });

  it("passes the user-selected merge strategy instead of hardcoding keep_latest", () => {
    expect(syncSettingsSection).toContain(
      "useState<MergeStrategy>('keep_latest')",
    );
    expect(syncSettingsSection).toContain(
      "runSyncWithProgress(direction, cloudConfig, syncStrategy)",
    );
    expect(syncSettingsSection).not.toContain(
      "runSyncWithProgress(direction, cloudConfig, 'keep_latest')",
    );
    // 策略选择器必须暴露全部 4 种策略
    for (const strategy of [
      "'keep_latest'",
      "'keep_local'",
      "'use_cloud'",
      "'manual'",
    ]) {
      expect(syncSettingsSection).toContain(`value: ${strategy}`);
    }
  });

  it("exposes quarantine management through Tauri, API, and settings UI", () => {
    expect(tauriLib).toContain("data_governance_list_quarantine");
    expect(tauriLib).toContain("data_governance_retry_quarantine");
    expect(tauriLib).toContain("data_governance_discard_quarantine");
    expect(dataGovernanceApi).toContain("invoke<SyncQuarantineRow[]>");
    expect(dataGovernanceApi).toContain("data_governance_list_quarantine");
    expect(dataGovernanceApi).toContain("data_governance_retry_quarantine");
    expect(dataGovernanceApi).toContain("data_governance_discard_quarantine");
    expect(syncTab).toContain("SyncQuarantinePanel");
  });

  it("keeps legacy sync conflict dialog failures visible and refreshes after single resolve", () => {
    const singleResolveStart = syncConflictDialog.indexOf(
      "const handleResolve = useCallback",
    );
    const singleResolveEnd = syncConflictDialog.indexOf(
      "  // 批量解决",
      singleResolveStart,
    );
    const singleResolveBlock = syncConflictDialog.slice(
      singleResolveStart,
      singleResolveEnd,
    );

    expect(singleResolveBlock).toContain("onResolved?.()");
    expect(singleResolveBlock).toContain("unifiedAlert(");
    expect(singleResolveBlock).toContain("notifications.conflictResolveFailed");
    expect(syncConflictDialog).toContain(
      "notifications.conflictBatchResolveFailed",
    );
  });
});
