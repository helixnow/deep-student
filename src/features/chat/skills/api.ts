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
