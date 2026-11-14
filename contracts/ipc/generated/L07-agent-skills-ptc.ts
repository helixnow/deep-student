// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L07-agent-skills-ptc.json
/* eslint-disable */

/** dstu_agent::chat_v2::tools::workbench_bridge::AcrBridgeCancel */
export type AcrBridgeCancel = {
  correlationId: string;
  bridgeToken: string;
  runId: string;
  toolCallId: string;
  sessionId: string;
};
/** dstu_agent::chat_v2::tools::workbench_bridge::AcrBridgeRequest */
export type AcrBridgeRequest = {
  correlationId: string;
  bridgeToken: string;
  command: string;
  args: unknown;
  timeoutMs: number;
  runId: string;
  toolCallId: string;
  sessionId: string;
};
/** dstu_agent::chat_v2::skill_replay::CandidateSignalCounts */
export type CandidateSignalCounts = {
  distinctTools: number;
  toolCalls: number;
  failedToolCalls: number;
  skillsLoaded: number;
  correctedSkills: number;
};
/** dstu_agent::chat_v2::skill_usage::CandidateSourceKind */
export type CandidateSourceKind = "trajectory" | "user_correction";
/** dstu_agent::chat_v2::skill_usage::CandidateStatus */
export type CandidateStatus = "new" | "screened" | "replaying" | "passed" | "failed" | "published" | "rolled_back";
/** dstu_agent::chat_v2::skill_replay::ReplayReport */
export type ReplayReport = {
  candidateId: string;
  sourceKind: CandidateSourceKind;
  sessionId: string;
  stillValid: boolean;
  driftReasons: string[];
  traceHashStored: string;
  traceHashRecomputed: string | null;
  traceHashMatches: boolean;
  previousStatus: CandidateStatus;
  resultingStatus: CandidateStatus;
  replayedAt: string;
};
/** dstu_agent::chat_v2::skill_replay::SkillCandidatePromotion */
export type SkillCandidatePromotion = {
  candidateId: string;
  status: CandidateStatus;
  draftPayload: unknown;
  promotedAt: string;
  skillId: string;
  skillFilePath: string;
  skillVersion: number;
  skillFileWritten: boolean;
};
/** dstu_agent::chat_v2::skill_replay::SkillCandidateRollback */
export type SkillCandidateRollback = {
  candidateId: string;
  status: CandidateStatus;
  skillId: string;
  retiredFrom: string | null;
  archivedTo: string | null;
  rolledBackAt: string;
};
/** dstu_agent::chat_v2::skill_replay::SkillCandidateSummary */
export type SkillCandidateSummary = {
  candidateId: string;
  sourceKind: CandidateSourceKind;
  status: CandidateStatus;
  sessionId: string;
  traceHash: string;
  skillIds: string[];
  signals: CandidateSignalCounts;
  createdAt: string;
  updatedAt: string;
};
/** dstu_agent::chat_v2::skills::SkillDirectoryEntry */
export type SkillDirectoryEntry = {
  name: string;
  path: string;
};
/** dstu_agent::chat_v2::skills::SkillFileContent */
export type SkillFileContent = {
  content: string;
  path: string;
};
/** dstu_agent::chat_v2::skills::SkillImportZipResult */
export type SkillImportZipResult = {
  skill_id: string;
  path: string;
  files_extracted: number;
  scripts_count: number;
  references_count: number;
  allowed_tools_count: number;
  package_sha256: string;
  risk_level: string;
  risk_signals: string[];
  requires?: SkillRequiresProbe | null;
};
/** dstu_agent::chat_v2::skill_market_client::SkillMarketDownloadScanResult */
export type SkillMarketDownloadScanResult = {
  slug: string;
  version: string;
  provenance: string;
  tempZipPath?: string | null;
  sourceKind: string;
  scan: SkillImportZipResult;
  installed: boolean;
};
/** dstu_agent::chat_v2::skill_market_client::SkillMarketSearchResponse */
export type SkillMarketSearchResponse = {
  mode: string;
  items: SkillMarketSkillCard[];
};
/** dstu_agent::chat_v2::skill_market_client::SkillMarketSkillCard */
export type SkillMarketSkillCard = {
  slug: string;
  displayName: string;
  summary: string;
  version: string;
  downloads: number;
  ownerHandle: string;
  stars: number;
  verify?: SkillMarketVerifyResult | null;
};
/** dstu_agent::chat_v2::skill_market_client::SkillMarketSkillDetail */
export type SkillMarketSkillDetail = {
  slug: string;
  displayName: string;
  summary: string;
  description: string;
  version: string;
  downloads: number;
  stars: number;
  ownerHandle: string;
  ownerDisplayName: string;
};
/** dstu_agent::chat_v2::skill_market_client::SkillMarketVerifyResult */
export type SkillMarketVerifyResult = {
  ok: boolean;
  decision: string;
  reasons: string[];
  slug: string;
  version: string;
  securityStatus: string;
  securityPassed: boolean;
  publisherHandle: string;
  publisherDisplayName: string;
};
/** dstu_agent::chat_v2::skills::SkillPackageFileEntry */
export type SkillPackageFileEntry = {
  path: string;
  size: number;
};
/** dstu_agent::chat_v2::skill_requires::SkillRequiresBinProbe */
export type SkillRequiresBinProbe = {
  name: string;
  found: boolean;
};
/** dstu_agent::chat_v2::skill_requires::SkillRequiresEnvProbe */
export type SkillRequiresEnvProbe = {
  name: string;
  set: boolean;
};
/** dstu_agent::chat_v2::skill_requires::SkillRequiresProbe */
export type SkillRequiresProbe = {
  bins: SkillRequiresBinProbe[];
  env: SkillRequiresEnvProbe[];
  python_packages: SkillRequiresPythonPackageProbe[];
  invalid: string[];
  missing_count: number;
};
/** dstu_agent::chat_v2::skill_requires::SkillRequiresPythonPackageProbe */
export type SkillRequiresPythonPackageProbe = {
  name: string;
  found: boolean;
};
/** dstu_agent::chat_v2::skill_updates::SkillUpdateApplyResult */
export type SkillUpdateApplyResult = {
  skillId: string;
  updated: boolean;
  packageSha256: string;
  riskLevel: string;
  path: string;
  trustStatus: string;
};
/** dstu_agent::chat_v2::skill_updates::SkillUpdateCheckResult */
export type SkillUpdateCheckResult = {
  skillId: string;
  checkable: boolean;
  updateAvailable: boolean;
  sourceKind: string;
  sourceSummary: string;
  currentSha256: string;
  remoteSha256: string | null;
  currentVersion?: string | null;
  remoteVersion?: string | null;
  error: string | null;
};
/** dstu_agent::chat_v2::skill_taps::TapCatalog */
export type TapCatalog = {
  repoUrl: string;
  resolvedZipUrl: string;
  skills: TapCatalogEntry[];
};
/** dstu_agent::chat_v2::skill_taps::TapCatalogEntry */
export type TapCatalogEntry = {
  subdir: string;
  skillId: string;
  name: string;
  description: string;
  version: string;
  fileCount: number;
};
/** dstu_agent::chat_v2::skill_taps::TapExportResult */
export type TapExportResult = {
  path: string;
  skillCount: number;
  fileCount: number;
};

export interface Commands {
  /** crates/dstu-agent/src/chat_v2/skill_replay.rs:1263 `chat_v2_list_skill_candidates` */
  chat_v2_list_skill_candidates: {
    args: {
      status?: string | null;
      limit?: number | null;
    };
    result: SkillCandidateSummary[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skill_replay.rs:1308 `chat_v2_promote_skill_candidate` */
  chat_v2_promote_skill_candidate: {
    args: {
      candidateId: string;
    };
    result: SkillCandidatePromotion;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skill_usage.rs:1101 `chat_v2_record_skill_activation` */
  chat_v2_record_skill_activation: {
    args: {
      skillId: string;
      sessionId?: string | null;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skill_replay.rs:1287 `chat_v2_replay_skill_candidate` */
  chat_v2_replay_skill_candidate: {
    args: {
      candidateId: string;
    };
    result: ReplayReport;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skill_replay.rs:1331 `chat_v2_rollback_skill_candidate` */
  chat_v2_rollback_skill_candidate: {
    args: {
      candidateId: string;
    };
    result: SkillCandidateRollback;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skill_updates.rs:354 `skill_check_updates` */
  skill_check_updates: {
    args: {
      skillIds?: string[] | null;
    };
    result: SkillUpdateCheckResult[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skills.rs:646 `skill_create` */
  skill_create: {
    args: {
      basePath: string;
      skillId: string;
      content: string;
    };
    result: SkillFileContent;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skills.rs:796 `skill_delete` */
  skill_delete: {
    args: {
      path: string;
    };
    result: null;
    error: string;
  };
  /** src/chat_v2/skill_taps.rs:17 `skill_export_tap` */
  skill_export_tap: {
    args: {
      skillIds: string[];
      destPath: string;
    };
    result: TapExportResult;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skills.rs:2320 `skill_import_zip` */
  skill_import_zip: {
    args: {
      zipPath: string;
      basePath: string;
      overwrite: boolean;
      dryRun?: boolean | null;
    };
    result: SkillImportZipResult;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skills.rs:370 `skill_list_directories` */
  skill_list_directories: {
    args: {
      path: string;
    };
    result: SkillDirectoryEntry[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skills.rs:565 `skill_list_package_files` */
  skill_list_package_files: {
    args: {
      path: string;
    };
    result: SkillPackageFileEntry[];
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skill_market_client.rs:1277 `skill_market_download_and_scan` */
  skill_market_download_and_scan: {
    args: {
      slug: string;
      version?: string | null;
      install?: boolean | null;
      overwrite?: boolean | null;
      expectedPackageSha256?: string | null;
      tempZipPath?: string | null;
      declaredRiskLevel?: string | null;
    };
    result: SkillMarketDownloadScanResult;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skill_market_client.rs:1196 `skill_market_search` */
  skill_market_search: {
    args: {
      q?: string | null;
      limit?: number | null;
      nonSuspiciousOnly?: boolean | null;
      sort?: string | null;
    };
    result: SkillMarketSearchResponse;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skill_market_client.rs:1237 `skill_market_skill_detail` */
  skill_market_skill_detail: {
    args: {
      slug: string;
    };
    result: SkillMarketSkillDetail;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skill_market_client.rs:1252 `skill_market_verify` */
  skill_market_verify: {
    args: {
      slug: string;
      version?: string | null;
    };
    result: SkillMarketVerifyResult;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skill_requires.rs:87 `skill_probe_requires` */
  skill_probe_requires: {
    args: {
      bins?: string[] | null;
      env?: string[] | null;
      pythonPackages?: string[] | null;
    };
    result: SkillRequiresProbe;
    error: never;
  };
  /** crates/dstu-agent/src/chat_v2/skills.rs:595 `skill_read_file` */
  skill_read_file: {
    args: {
      path: string;
    };
    result: SkillFileContent;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skill_taps.rs:462 `skill_tap_catalog` */
  skill_tap_catalog: {
    args: {
      repoUrl: string;
    };
    result: TapCatalog;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skill_taps.rs:489 `skill_tap_install` */
  skill_tap_install: {
    args: {
      zipUrl: string;
      subdir: string;
      overwrite: boolean;
      dryRun?: boolean | null;
      expectedPackageSha256?: string | null;
    };
    result: SkillImportZipResult;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skills.rs:743 `skill_update` */
  skill_update: {
    args: {
      path: string;
      content: string;
    };
    result: SkillFileContent;
    error: string;
  };
  /** crates/dstu-agent/src/chat_v2/skill_updates.rs:414 `skill_update_from_source` */
  skill_update_from_source: {
    args: {
      skillId: string;
    };
    result: SkillUpdateApplyResult;
    error: string;
  };
}

export interface Events {
  "acr:bridge-cancel": AcrBridgeCancel;
  "acr:bridge-request": AcrBridgeRequest;
  "chat_v2://settings_changed": {
    action: string;
    key: string;
  };
  "skill-lifecycle-bridge-request": {
    correlationId: string;
    command: string;
    args: unknown;
    sessionId: string;
  };
}

export type CommandName = keyof Commands;
export type ChatV2ListSkillCandidatesCommandArgs = Commands['chat_v2_list_skill_candidates']['args'];
export type ChatV2ListSkillCandidatesCommandResult = Commands['chat_v2_list_skill_candidates']['result'];
export type ChatV2PromoteSkillCandidateCommandArgs = Commands['chat_v2_promote_skill_candidate']['args'];
export type ChatV2PromoteSkillCandidateCommandResult = Commands['chat_v2_promote_skill_candidate']['result'];
export type ChatV2RecordSkillActivationCommandArgs = Commands['chat_v2_record_skill_activation']['args'];
export type ChatV2RecordSkillActivationCommandResult = Commands['chat_v2_record_skill_activation']['result'];
export type ChatV2ReplaySkillCandidateCommandArgs = Commands['chat_v2_replay_skill_candidate']['args'];
export type ChatV2ReplaySkillCandidateCommandResult = Commands['chat_v2_replay_skill_candidate']['result'];
export type ChatV2RollbackSkillCandidateCommandArgs = Commands['chat_v2_rollback_skill_candidate']['args'];
export type ChatV2RollbackSkillCandidateCommandResult = Commands['chat_v2_rollback_skill_candidate']['result'];
export type SkillCheckUpdatesCommandArgs = Commands['skill_check_updates']['args'];
export type SkillCheckUpdatesCommandResult = Commands['skill_check_updates']['result'];
export type SkillCreateCommandArgs = Commands['skill_create']['args'];
export type SkillCreateCommandResult = Commands['skill_create']['result'];
export type SkillDeleteCommandArgs = Commands['skill_delete']['args'];
export type SkillDeleteCommandResult = Commands['skill_delete']['result'];
export type SkillExportTapCommandArgs = Commands['skill_export_tap']['args'];
export type SkillExportTapCommandResult = Commands['skill_export_tap']['result'];
export type SkillImportZipCommandArgs = Commands['skill_import_zip']['args'];
export type SkillImportZipCommandResult = Commands['skill_import_zip']['result'];
export type SkillListDirectoriesCommandArgs = Commands['skill_list_directories']['args'];
export type SkillListDirectoriesCommandResult = Commands['skill_list_directories']['result'];
export type SkillListPackageFilesCommandArgs = Commands['skill_list_package_files']['args'];
export type SkillListPackageFilesCommandResult = Commands['skill_list_package_files']['result'];
export type SkillMarketDownloadAndScanCommandArgs = Commands['skill_market_download_and_scan']['args'];
export type SkillMarketDownloadAndScanCommandResult = Commands['skill_market_download_and_scan']['result'];
export type SkillMarketSearchCommandArgs = Commands['skill_market_search']['args'];
export type SkillMarketSearchCommandResult = Commands['skill_market_search']['result'];
export type SkillMarketSkillDetailCommandArgs = Commands['skill_market_skill_detail']['args'];
export type SkillMarketSkillDetailCommandResult = Commands['skill_market_skill_detail']['result'];
export type SkillMarketVerifyCommandArgs = Commands['skill_market_verify']['args'];
export type SkillMarketVerifyCommandResult = Commands['skill_market_verify']['result'];
export type SkillProbeRequiresCommandArgs = Commands['skill_probe_requires']['args'];
export type SkillProbeRequiresCommandResult = Commands['skill_probe_requires']['result'];
export type SkillReadFileCommandArgs = Commands['skill_read_file']['args'];
export type SkillReadFileCommandResult = Commands['skill_read_file']['result'];
export type SkillTapCatalogCommandArgs = Commands['skill_tap_catalog']['args'];
export type SkillTapCatalogCommandResult = Commands['skill_tap_catalog']['result'];
export type SkillTapInstallCommandArgs = Commands['skill_tap_install']['args'];
export type SkillTapInstallCommandResult = Commands['skill_tap_install']['result'];
export type SkillUpdateCommandArgs = Commands['skill_update']['args'];
export type SkillUpdateCommandResult = Commands['skill_update']['result'];
export type SkillUpdateFromSourceCommandArgs = Commands['skill_update_from_source']['args'];
export type SkillUpdateFromSourceCommandResult = Commands['skill_update_from_source']['result'];
