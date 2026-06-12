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

  it("hydrates FTP passwords only from secure storage", () => {
    const ftpBranchStart = cloudStorageApi.indexOf(
      "if (safe.provider === 'ftp')",
    );
    const ftpBranchEnd = cloudStorageApi.indexOf(
      "  return {\n    ...safe,\n    s3:",
      ftpBranchStart,
    );
    const ftpBranch = cloudStorageApi.slice(ftpBranchStart, ftpBranchEnd);

    expect(ftpBranchStart).toBeGreaterThan(-1);
    expect(ftpBranch).toContain("password: credentials?.ftpPassword ??");
    expect(ftpBranch).not.toContain("safe.ftp.password");
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
