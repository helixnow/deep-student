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
  const examContentView = readFileSync(
    resolve(
      process.cwd(),
      "src/features/learning-hub/apps/views/ExamContentView.tsx",
    ),
    "utf-8",
  );
  const tauriLib = readFileSync(
    resolve(process.cwd(), "src-tauri/src/lib.rs"),
    "utf-8",
  );

  it("never persists FTP passwords in the safe localStorage config", () => {
    expect(cloudStorageSection).toContain(
      "ftpPassword:",
    );
    expect(cloudStorageSection).toContain(
      "provider === 'ftp' && ftpConfig.password.trim()",
    );
    expect(cloudStorageApi).toContain(
      "export function toSafeCloudStorageConfig",
    );
    const safeFtpCaseStart = cloudStorageApi.indexOf("case 'ftp': {");
    const safeFtpCaseEnd = cloudStorageApi.indexOf("\n    }", safeFtpCaseStart);
    const safeFtpCase = cloudStorageApi.slice(safeFtpCaseStart, safeFtpCaseEnd);
    expect(safeFtpCase).toContain("username: config.ftp.username");
    expect(safeFtpCase).not.toContain("password:");
    expect(cloudStorageSection).toContain(
      "localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(published.config))",
    );
  });

  // [R2 配置事务边界] 保存/发布是后端 cloud_config_publish 的单逻辑提交：
  // 失败保持旧 generation，前端只在发布成功后写 UI 缓存与迁移标记。
  it("publishes credentials and config as one logical commit, caching only after success", () => {
    const saveStart = cloudStorageSection.indexOf(
      "const doSaveConfig = useCallback",
    );
    const saveEnd = cloudStorageSection.indexOf(
      "  // 保存配置（先检查不安全连接）",
      saveStart,
    );
    const saveBlock = cloudStorageSection.slice(saveStart, saveEnd);

    expect(saveBlock.indexOf("await cloudApi.publishCloudConfig")).toBeGreaterThan(-1);
    // 旧的两段非事务写（安全存储→设置库）不得回归到保存路径
    expect(saveBlock).not.toContain("cloudApi.saveCredentials");
    expect(saveBlock).not.toContain("cloudApi.saveCloudConfigSsot");
    expect(saveBlock.indexOf("localStorage.setItem(CONFIG_STORAGE_KEY")).toBeGreaterThan(
      saveBlock.indexOf("await cloudApi.publishCloudConfig"),
    );
    expect(saveBlock).toMatch(/showGlobalNotification\(\s*'error'/);
    expect(saveBlock).toContain("return;");
    expect(cloudStorageApi).toContain("'cloud_config_publish'");
  });

  // [R2 配置事务边界] 测试按钮走一次性草稿命令：成功/失败都不持久化。
  // 测试失败的配置只存在于表单草稿，绝不能成为已发布 SSOT 或本地缓存。
  it("tests connections against the draft command without persisting anything", () => {
    const testStart = cloudStorageSection.indexOf(
      "const doTestConnection = useCallback",
    );
    const testEnd = cloudStorageSection.indexOf(
      "const handleConfirmInsecureFtpSave = useCallback",
      testStart,
    );
    expect(testStart).toBeGreaterThan(-1);
    expect(testEnd).toBeGreaterThan(testStart);
    const testBlock = cloudStorageSection.slice(testStart, testEnd);

    expect(testBlock).toContain("cloudApi.testConnectionDraft");
    // 测试路径不得触碰任何持久化：不写安全存储、不写后端 SSOT、
    // 不写 localStorage 缓存/迁移标记，也不得改走发布命令。
    expect(testBlock).not.toContain("cloudApi.saveCredentials");
    expect(testBlock).not.toContain("cloudApi.saveCloudConfigSsot");
    expect(testBlock).not.toContain("cloudApi.publishCloudConfig");
    expect(testBlock).not.toContain("localStorage.setItem");
    // checkConnection 会让后端 hydrate 已发布凭据，测不了草稿，禁止回归
    expect(testBlock).not.toContain("cloudApi.checkConnection");
    expect(cloudStorageApi).toContain("'cloud_config_test_connection_draft'");
  });

  // [P0-3A] 2026-06-12 更新：前端不再回填明文凭据，敏感字段一律传空占位，
  // 由后端 hydrate_cloud_config 从系统安全存储补全（明文不过 IPC）。
  it("sends empty FTP password placeholders instead of hydrating plaintext in the frontend", () => {
    const fromSafeStart = cloudStorageApi.indexOf(
      "export function fromSafeCloudStorageConfig",
    );
    const fromSafeEnd = cloudStorageApi.indexOf(
      "export function toRuntimeCloudStorageConfig",
      fromSafeStart,
    );
    const fromSafeBlock = cloudStorageApi.slice(fromSafeStart, fromSafeEnd);

    expect(fromSafeStart).toBeGreaterThan(-1);
    expect(fromSafeBlock).toContain("ftp: { ...config.ftp, password: '' }");
    expect(fromSafeBlock).not.toContain("config.ftp.password");
    expect(cloudStorageApi).toContain(
      "fromSafeCloudStorageConfig(toSafeCloudStorageConfig(config))",
    );
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

  it("routes record conflicts through data-governance UI, not the retired qbank dialog", () => {
    // 题库专属 SyncConflictDialog / qbank_*_sync_* 已退役（无生产生产者）。
    expect(examContentView).not.toContain("SyncConflictDialog");
    expect(examContentView).not.toContain("qbank_get_sync_conflicts");
    expect(tauriLib).not.toContain("qbank_get_sync_conflicts");
    expect(tauriLib).not.toContain("qbank_resolve_sync_conflict");
    // 真冲突源：记录级 __sync_conflicts
    expect(syncTab).toContain("RecordConflictsPanel");
    expect(dataGovernanceApi).toContain("data_governance_list_record_conflicts");
    expect(dataGovernanceApi).toContain("data_governance_resolve_record_conflict");
  });
});
