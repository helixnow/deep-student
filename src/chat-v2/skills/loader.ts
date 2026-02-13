/**
 * Chat V2 - Skills 文件系统加载器
 *
 * 从文件系统加载 SKILL.md 文件
 * 支持全局目录（~/.deep-student/skills）和项目目录（.skills）
 *
 * 设计说明：
 * - 使用 Tauri invoke 调用后端读取文件
 * - 解析 SKILL.md 文件并注册到 skillRegistry
 * - 支持热重载（reload）
 */

import { invoke } from '@tauri-apps/api/core';
import { parseSkillFile } from './parser';
import { skillRegistry } from './registry';
import type { SkillDefinition, SkillLocation, SkillLoadConfig } from './types';
import { DEFAULT_SKILL_LOAD_CONFIG } from './types';
import { getBuiltinSkills } from './builtin';
import {
  getAllBuiltinSkillCustomizations,
  applyCustomizationToSkill,
} from './builtinStorage';
import { getBuiltinToolSkills } from './builtin-tools';
import { debugLog } from '../../debug-panel/debugMasterSwitch';

// ============================================================================
// 常量
// ============================================================================

const LOG_PREFIX = '[SkillLoader]';
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/**
 * SKILL.md 文件名
 */
const SKILL_FILE_NAME = 'SKILL.md';

/**
 * 是否在 Tauri 运行时
 *
 * 说明：在 Web/测试环境中可能不存在 window 或 __TAURI_INTERNALS__
 */
function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

/**
 * 解析默认的项目根目录（用于生产环境下的 project skills）
 *
 * 背景：
 * - Tauri 打包后后端 cwd 不稳定，直接使用相对路径（如 ".skills"）行为不可预测
 * - 生产环境下默认将 project skills 映射到 appDataDir 下，保证稳定可写
 *
 * 约束：
 * - 开发环境保持旧行为（使用相对路径，便于在仓库根目录直接放置 .skills）
 */
async function resolveDefaultProjectRootDir(): Promise<string | null> {
  // 开发环境保持原语义：相对路径直接交给后端 cwd 处理
  if (import.meta.env.DEV) return null;
  if (!isTauriRuntime()) return null;

  try {
    const { appDataDir } = await import('@tauri-apps/api/path');
    return await appDataDir();
  } catch (error: unknown) {
    console.warn(LOG_PREFIX, 'Cannot get appDataDir as default projectRootDir, falling back to relative path:', error);
    return null;
  }
}

// ============================================================================
// 后端数据类型
// ============================================================================

/**
 * 后端返回的目录项
 */
interface SkillDirectoryEntry {
  /** 目录名（即 skill ID） */
  name: string;
  /** 完整路径 */
  path: string;
}

/**
 * 后端返回的 skill 文件内容
 */
interface SkillFileContent {
  /** 文件内容 */
  content: string;
  /** 文件路径 */
  path: string;
}

// ============================================================================
// 加载函数
// ============================================================================

/**
 * 从单个目录加载 skills
 *
 * 流程：
 * 1. 列出目录下所有子目录
 * 2. 检查每个子目录是否包含 SKILL.md
 * 3. 解析 SKILL.md 文件
 * 4. 返回成功解析的 SkillDefinition 列表
 *
 * @param dirPath 目录路径
 * @param location 来源位置
 * @returns 解析成功的 skills 列表
 */
async function loadSkillsFromDirectory(
  dirPath: string,
  location: SkillLocation
): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];

  try {
    // 调用后端列出目录
    const entries = await invoke<SkillDirectoryEntry[]>('skill_list_directories', {
      path: dirPath,
    });

    console.log(
      LOG_PREFIX,
      `发现 ${entries.length} 个潜在 skill 目录 (${location}):`,
      dirPath
    );

    // 遍历每个子目录
    for (const entry of entries) {
      const skillFilePath = `${entry.path}/${SKILL_FILE_NAME}`;

      try {
        // 读取 SKILL.md 文件
        const fileResult = await invoke<SkillFileContent>('skill_read_file', {
          path: skillFilePath,
        });

        // 解析文件
        const parseResult = parseSkillFile(
          fileResult.content,
          fileResult.path,
          entry.name, // 使用目录名作为 skill ID
          location
        );

        if (parseResult.success && parseResult.skill) {
          skills.push(parseResult.skill);
          console.log(
            LOG_PREFIX,
            `已加载 skill: ${parseResult.skill.name} (${entry.name})`
          );

          // 输出警告
          if (parseResult.warnings && parseResult.warnings.length > 0) {
            console.warn(
              LOG_PREFIX,
              `${entry.name} 警告:`,
              parseResult.warnings.join('; ')
            );
          }
        } else {
          console.warn(
            LOG_PREFIX,
            `解析 skill 失败: ${entry.name}`,
            parseResult.error
          );
        }
      } catch (readError: unknown) {
        // SKILL.md 不存在，跳过此目录
        // 这是正常情况，不需要记录错误
        console.debug(
          LOG_PREFIX,
          `目录 ${entry.name} 无 SKILL.md，跳过`
        );
      }
    }

    return skills;
  } catch (error: unknown) {
    console.warn(
      LOG_PREFIX,
      `无法访问目录 ${dirPath}:`,
      error
    );
    return [];
  }
}

/**
 * 从文件系统加载所有 skills
 *
 * 按顺序加载（优先级从低到高）：
 * 1. 内置 skills（builtin）- 最低优先级
 * 2. 全局 skills（~/.deep-student/skills）
 * 3. 项目 skills（.skills）- 最高优先级
 *
 * 后加载的 skills 会覆盖同 ID 的先加载 skills
 *
 * @param config 加载配置
 * @returns 加载结果统计
 */
export async function loadSkillsFromFileSystem(
  config: SkillLoadConfig = {}
): Promise<{
  total: number;
  builtin: number;
  global: number;
  project: number;
  errors: number;
}> {
  const mergedConfig = { ...DEFAULT_SKILL_LOAD_CONFIG, ...config };
  const stats = { total: 0, builtin: 0, global: 0, project: 0, errors: 0 };

  console.log(LOG_PREFIX, 'Loading skills...');

  // 1. 加载内置 skills（最低优先级）
  // ★ P0-07 修复：检查 loadBuiltin 配置
  // ★ 2026-01-15：支持用户自定义内置 skills
  // ★ 2026-01-20：加载内置工具组 Skills（渐进披露架构）
  if (mergedConfig.loadBuiltin !== false) {
    try {
      const builtinSkills = getBuiltinSkills();
      const builtinIds = builtinSkills.map((s) => s.id);

      // 加载用户对内置 skills 的自定义数据
      const customizations = await getAllBuiltinSkillCustomizations(builtinIds);
      const customizedCount = customizations.size;

      // 应用自定义数据并注册
      for (const skill of builtinSkills) {
        const customization = customizations.get(skill.id) ?? null;
        const finalSkill = applyCustomizationToSkill(skill, customization);
        skillRegistry.register(finalSkill);
        stats.builtin++;
      }

      // 🆕 加载内置工具组 Skills（渐进披露架构）
      const builtinToolSkills = getBuiltinToolSkills();
      for (const skill of builtinToolSkills) {
        skillRegistry.register(skill);
        stats.builtin++;
      }

      console.log(
        LOG_PREFIX,
        `已加载 ${stats.builtin} 个内置 skills（${customizedCount} 个已自定义，${builtinToolSkills.length} 个工具组）`
      );
    } catch (error: unknown) {
      console.error(LOG_PREFIX, 'Failed to load builtin skills:', error);
      stats.errors++;
    }
  } else {
    console.log(LOG_PREFIX, 'loadBuiltin=false, skipping builtin skills load');
  }

  // 2. 加载全局 skills
  if (mergedConfig.globalPath) {
    try {
      const globalSkills = await loadSkillsFromDirectory(
        mergedConfig.globalPath,
        'global'
      );

      for (const skill of globalSkills) {
        skillRegistry.register(skill);
        stats.global++;
      }
    } catch (error: unknown) {
      console.error(LOG_PREFIX, 'Failed to load global skills:', error);
      stats.errors++;
    }
  }

  // 3. 加载项目 skills（最高优先级）
  // ★ P0-08 修复：支持 projectRootDir 用于解析相对路径
  if (mergedConfig.projectPath) {
    try {
      let projectSkillsPath = mergedConfig.projectPath;

      // 如果未提供 projectRootDir（且为相对路径），尝试在生产环境下提供稳定默认值
      const defaultProjectRootDir = !mergedConfig.projectRootDir
        ? await resolveDefaultProjectRootDir()
        : null;

      const effectiveProjectRootDir = mergedConfig.projectRootDir ?? defaultProjectRootDir;

      // 如果提供了（显式或默认）projectRootDir，将相对路径转换为绝对路径
      if (effectiveProjectRootDir && !projectSkillsPath.startsWith('/') && !projectSkillsPath.startsWith('~')) {
        projectSkillsPath = `${effectiveProjectRootDir}/${mergedConfig.projectPath}`;
        console.log(LOG_PREFIX, `Resolved project skills path: ${mergedConfig.projectPath} → ${projectSkillsPath}`);
      }

      const projectSkills = await loadSkillsFromDirectory(
        projectSkillsPath,
        'project'
      );

      for (const skill of projectSkills) {
        skillRegistry.register(skill);
        stats.project++;
      }
    } catch (error: unknown) {
      console.error(LOG_PREFIX, 'Failed to load project skills:', error);
      stats.errors++;
    }
  }

  stats.total = skillRegistry.size;

  console.log(
    LOG_PREFIX,
    `加载完成: 内置=${stats.builtin}, 全局=${stats.global}, 项目=${stats.project}, 总计=${stats.total}`
  );

  return stats;
}

/**
 * 重新加载所有 skills
 *
 * 清空现有 skills 并重新加载（包括内置 skills）
 *
 * @param config 加载配置
 * @returns 加载结果统计
 */
export async function reloadSkills(
  config?: SkillLoadConfig
): Promise<{
  total: number;
  builtin: number;
  global: number;
  project: number;
  errors: number;
}> {
  console.log(LOG_PREFIX, 'Reloading skills...');

  // 清空现有 skills
  skillRegistry.clear();

  // 重新加载
  return loadSkillsFromFileSystem(config);
}

/**
 * 加载单个 skill 文件
 *
 * 用于热添加新 skill
 *
 * @param filePath SKILL.md 文件路径
 * @param skillId Skill ID
 * @param location 来源位置
 * @returns 是否加载成功
 */
export async function loadSingleSkill(
  filePath: string,
  skillId: string,
  location: SkillLocation
): Promise<boolean> {
  try {
    const fileResult = await invoke<SkillFileContent>('skill_read_file', {
      path: filePath,
    });

    const parseResult = parseSkillFile(
      fileResult.content,
      fileResult.path,
      skillId,
      location
    );

    if (parseResult.success && parseResult.skill) {
      skillRegistry.register(parseResult.skill);
      console.log(LOG_PREFIX, `Loaded single skill: ${parseResult.skill.name}`);
      return true;
    }

    console.warn(LOG_PREFIX, `Failed to parse skill:`, parseResult.error);
    return false;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, `Failed to load skill:`, error);
    return false;
  }
}
