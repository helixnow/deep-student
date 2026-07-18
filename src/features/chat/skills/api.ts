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
}): Promise<SkillPackageScanResult> {
  return invoke<SkillPackageScanResult>('skill_tap_install', {
    zipUrl: params.zipUrl,
    subdir: params.subdir,
    overwrite: params.overwrite,
    dryRun: params.dryRun ?? false,
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
  /** 是否可远程复查（url 来源才可） */
  checkable: boolean;
  /** 远程包与本地记录的 sha256 不同 */
  updateAvailable: boolean;
  sourceKind: string;
  sourceSummary: string;
  currentSha256: string;
  remoteSha256: string | null;
  error: string | null;
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
 * 只覆盖有 provenance 记录（链接/zip 安装）的技能；单个技能的
 * 下载失败记录在对应条目的 error 字段，不会使整个调用失败。
 */
export async function checkSkillUpdates(skillIds?: string[]): Promise<SkillUpdateCheckResult[]> {
  return invoke<SkillUpdateCheckResult[]>('skill_check_updates', {
    skillIds: skillIds ?? null,
  });
}

/**
 * 按 provenance 记录的来源 URL 重新安装（更新）技能
 *
 * 更新后技能回到未信任状态，需用户重新信任。
 */
export async function updateSkillFromSource(skillId: string): Promise<SkillUpdateApplyResult> {
  return invoke<SkillUpdateApplyResult>('skill_update_from_source', { skillId });
}
