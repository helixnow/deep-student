/**
 * Chat V2 - Skills API
 *
 * 封装后端 Tauri 命令调用
 */

import { invoke } from '@tauri-apps/api/core';

// ============================================================================
// 类型定义
// ============================================================================

export interface SkillFileContent {
  /** 文件内容 */
  content: string;
  /** 文件路径 */
  path: string;
}

export interface SkillDirectoryEntry {
  /** 目录名（即 skill ID） */
  name: string;
  /** 完整路径 */
  path: string;
}

export interface SkillPackageFileEntry {
  /** Path relative to package root, using forward slashes. */
  path: string;
  /** File size in bytes. */
  size: number;
}

export interface SkillCreateParams {
  /** 基础目录路径（全局或项目） */
  basePath: string;
  /** 技能 ID（将作为目录名） */
  skillId: string;
  /** SKILL.md 文件内容 */
  content: string;
}

export interface SkillUpdateParams {
  /** SKILL.md 文件完整路径 */
  path: string;
  /** 新的文件内容 */
  content: string;
}

// ============================================================================
// API 函数
// ============================================================================

/**
 * 列出技能目录
 *
 * @param path 目录路径（支持 ~ 展开）
 * @returns 目录列表
 */
export async function listSkillDirectories(path: string): Promise<SkillDirectoryEntry[]> {
  return invoke<SkillDirectoryEntry[]>('skill_list_directories', { path });
}

/**
 * 读取技能文件
 *
 * @param path 文件路径（支持 ~ 展开）
 * @returns 文件内容和路径
 */
export async function readSkillFile(path: string): Promise<SkillFileContent> {
  return invoke<SkillFileContent>('skill_read_file', { path });
}

/**
 * List package files under a skill directory.
 *
 * @param path Skill package root directory
 * @returns Relative package file paths
 */
export async function listSkillPackageFiles(path: string): Promise<SkillPackageFileEntry[]> {
  return invoke<SkillPackageFileEntry[]>('skill_list_package_files', { path });
}

/**
 * 创建新技能
 *
 * @param params 创建参数
 * @returns 创建的文件信息
 */
export async function createSkill(params: SkillCreateParams): Promise<SkillFileContent> {
  return invoke<SkillFileContent>('skill_create', {
    basePath: params.basePath,
    skillId: params.skillId,
    content: params.content,
  });
}

/**
 * 更新技能文件
 *
 * @param params 更新参数
 * @returns 更新后的文件信息
 */
export async function updateSkill(params: SkillUpdateParams): Promise<SkillFileContent> {
  return invoke<SkillFileContent>('skill_update', {
    path: params.path,
    content: params.content,
  });
}

/**
 * 删除技能目录
 *
 * @param path 技能目录路径
 */
export async function deleteSkill(path: string): Promise<void> {
  await invoke<void>('skill_delete', { path });
}

// ============================================================================
// Tap 式技能源（GitHub 仓库即技能目录）
// ============================================================================

export interface TapCatalogEntry {
  /** 相对仓库根的技能目录（根目录技能为空串） */
  subdir: string;
  /** 技能目录名（即安装后的 skill id；根目录技能为空串） */
  skillId: string;
  name: string;
  description: string;
  version: string;
  fileCount: number;
}

export interface TapCatalog {
  repoUrl: string;
  /** 解析出的 codeload zip 直链（传给 installTapSkill） */
  resolvedZipUrl: string;
  skills: TapCatalogEntry[];
}

/** 与后端 SkillImportZipResult 对齐（snake_case） */
export interface SkillPackageScanResult {
  skill_id: string;
  path: string;
  files_extracted: number;
  scripts_count: number;
  references_count: number;
  allowed_tools_count: number;
  package_sha256: string;
  risk_level: string;
  risk_signals: string[];
  requires?: {
    bins: Array<{ name: string; found: boolean }>;
    env: Array<{ name: string; set: boolean }>;
    invalid: string[];
    missing_count: number;
  };
}

/**
 * 浏览 tap 技能源：列出 GitHub 仓库中的全部技能（只读，不落盘）
 */
export async function fetchTapCatalog(repoUrl: string): Promise<TapCatalog> {
  return invoke<TapCatalog>('skill_tap_catalog', { repoUrl });
}

/**
 * 从 tap 技能源安装（或 dry_run 装前扫描）一个技能子目录
 */
export async function installTapSkill(params: {
  zipUrl: string;
  subdir: string;
  overwrite: boolean;
  dryRun?: boolean;
  expectedPackageSha256?: string | null;
}): Promise<SkillPackageScanResult> {
  return invoke<SkillPackageScanResult>('skill_tap_install', {
    zipUrl: params.zipUrl,
    subdir: params.subdir,
    overwrite: params.overwrite,
    dryRun: params.dryRun ?? false,
    expectedPackageSha256: params.expectedPackageSha256 ?? null,
  });
}

export interface TapExportResult {
  path: string;
  skillCount: number;
  fileCount: number;
}

/**
 * 把选定技能导出为 tap 结构 zip（README + 每技能一个顶层目录）。
 * 解压推到 GitHub 仓库即可作为技能源分享。
 */
export async function exportSkillsAsTap(
  skillIds: string[],
  destPath: string,
): Promise<TapExportResult> {
  return invoke<TapExportResult>('skill_export_tap', { skillIds, destPath });
}

// ============================================================================
// 更新检查（基于安装 provenance 的上游 drift 检测）
// ============================================================================

export interface SkillUpdateCheckResult {
  skillId: string;
  /** 是否可远程复查（url / tap / clawhub 来源） */
  checkable: boolean;
  /** 远程包与本地记录的 sha256 不同；clawhub 则为 version 不同 */
  updateAvailable: boolean;
  sourceKind: string;
  sourceSummary: string;
  /** 本地记录的 package sha256（所有来源均为真实哈希） */
  currentSha256: string;
  /** 远程 package sha256；clawhub 检查只比对 version、不下载包，为 null */
  remoteSha256: string | null;
  /** 已安装版本（目前仅 clawhub 来源填充） */
  currentVersion?: string | null;
  /** 远程 latest version（目前仅 clawhub 来源填充） */
  remoteVersion?: string | null;
  error: string | null;
}

/**
 * ClawHub 版本比对（与后端 clawhub_version_outdated 对齐）。
 * 远程非空且与本地不同 → outdated。
 */
export function isClawhubVersionOutdated(
  installedVersion: string,
  remoteVersion: string | null | undefined,
): boolean {
  const installed = installedVersion.trim();
  const remote = (remoteVersion ?? '').trim();
  return remote.length > 0 && remote !== installed;
}

/**
 * 由已安装 provenance + clawhub_skill_detail 结果构造更新检查条目（便于行为级单测）。
 */
export function buildClawhubUpdateCheckResult(params: {
  skillId: string;
  sourceDetail: string;
  installedVersion: string;
  remoteVersion: string | null;
  /** provenance 中记录的本地包哈希（可选，测试场景常省略） */
  packageSha256?: string;
  error?: string | null;
}): SkillUpdateCheckResult {
  const remote = params.remoteVersion?.trim() || null;
  const error = params.error ?? null;
  if (error) {
    return {
      skillId: params.skillId,
      checkable: true,
      updateAvailable: false,
      sourceKind: 'clawhub',
      sourceSummary: params.sourceDetail,
      currentSha256: params.packageSha256 ?? '',
      remoteSha256: null,
      currentVersion: params.installedVersion,
      remoteVersion: null,
      error,
    };
  }
  return {
    skillId: params.skillId,
    checkable: true,
    updateAvailable: isClawhubVersionOutdated(params.installedVersion, remote),
    sourceKind: 'clawhub',
    sourceSummary: params.sourceDetail,
    currentSha256: params.packageSha256 ?? '',
    remoteSha256: null,
    currentVersion: params.installedVersion,
    remoteVersion: remote,
    error: null,
  };
}

export interface SkillUpdateApplyResult {
  skillId: string;
  updated: boolean;
  packageSha256: string;
  riskLevel: string;
  path: string;
  /** 更新后包内容变化，信任指纹失效，需用户重新信任 */
  trustStatus: string;
}

/**
 * 检查已安装技能的上游更新
 *
 * 覆盖有 provenance 的 url / tap / clawhub 技能：
 * - url/tap：比对 package sha256
 * - clawhub：经 clawhub_skill_detail 比对 version
 *
 * 单个技能的检查失败记录在对应条目的 error 字段，不会使整个调用失败。
 */
export async function checkSkillUpdates(skillIds?: string[]): Promise<SkillUpdateCheckResult[]> {
  return invoke<SkillUpdateCheckResult[]>('skill_check_updates', {
    skillIds: skillIds ?? null,
  });
}

/**
 * 行为级辅助：对 mock 的 skill_check_updates 结果断言 clawhub outdated 标记。
 * （供测试与 UI 预过滤复用；error / RATE_LIMITED 行一律排除）
 */
export function selectOutdatedClawhubUpdates(
  results: SkillUpdateCheckResult[],
): SkillUpdateCheckResult[] {
  return results.filter(
    (r) => r.sourceKind === 'clawhub' && r.checkable && r.updateAvailable && !r.error,
  );
}

/**
 * 按 provenance 记录的来源 URL 重新安装（更新）技能
 *
 * 更新后技能回到未信任状态，需用户重新信任。
 */
export async function updateSkillFromSource(skillId: string): Promise<SkillUpdateApplyResult> {
  return invoke<SkillUpdateApplyResult>('skill_update_from_source', { skillId });
}

// ============================================================================
// ClawHub 技能市场
// ============================================================================

export interface ClawHubVerifyResult {
  ok: boolean;
  decision: string;
  reasons: string[];
  slug: string;
  version: string;
  securityStatus: string;
  securityPassed: boolean;
  publisherHandle: string;
  publisherDisplayName: string;
}

export interface ClawHubSkillCard {
  slug: string;
  displayName: string;
  summary: string;
  version: string;
  downloads: number;
  ownerHandle: string;
  stars: number;
  verify?: ClawHubVerifyResult | null;
}

export interface ClawHubSearchResponse {
  mode: string;
  items: ClawHubSkillCard[];
}

export interface ClawHubSkillDetail {
  slug: string;
  displayName: string;
  summary: string;
  description: string;
  version: string;
  downloads: number;
  stars: number;
  ownerHandle: string;
  ownerDisplayName: string;
}

export interface ClawHubDownloadScanResult {
  slug: string;
  version: string;
  /** clawhub:{slug}@{version} */
  provenance: string;
  tempZipPath?: string | null;
  sourceKind: string;
  scan: SkillPackageScanResult;
  installed: boolean;
}

/**
 * 搜索或浏览 ClawHub（q 为空时返回 trending/排序列表）。
 * nonSuspiciousOnly 默认 true。
 */
export async function clawhubSearch(params?: {
  q?: string;
  limit?: number;
  nonSuspiciousOnly?: boolean;
  sort?: 'trending' | 'downloads' | 'stars';
}): Promise<ClawHubSearchResponse> {
  return invoke<ClawHubSearchResponse>('clawhub_search', {
    q: params?.q ?? null,
    limit: params?.limit ?? null,
    nonSuspiciousOnly: params?.nonSuspiciousOnly ?? true,
    sort: params?.sort ?? null,
  });
}

export async function clawhubSkillDetail(slug: string): Promise<ClawHubSkillDetail> {
  return invoke<ClawHubSkillDetail>('clawhub_skill_detail', { slug });
}

export async function clawhubVerify(
  slug: string,
  version?: string | null,
): Promise<ClawHubVerifyResult> {
  return invoke<ClawHubVerifyResult>('clawhub_verify', {
    slug,
    version: version ?? null,
  });
}

/**
 * 下载 ClawHub 技能并扫描（install=false）；确认后传 install=true 安装并写 provenance。
 */
export async function clawhubDownloadAndScan(params: {
  slug: string;
  version?: string | null;
  install?: boolean;
  overwrite?: boolean;
  expectedPackageSha256?: string | null;
  tempZipPath?: string | null;
}): Promise<ClawHubDownloadScanResult> {
  return invoke<ClawHubDownloadScanResult>('clawhub_download_and_scan', {
    slug: params.slug,
    version: params.version ?? null,
    install: params.install ?? false,
    overwrite: params.overwrite ?? false,
    expectedPackageSha256: params.expectedPackageSha256 ?? null,
    tempZipPath: params.tempZipPath ?? null,
  });
}
