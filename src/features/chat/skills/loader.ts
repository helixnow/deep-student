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
import type { SkillDefinition, SkillLocation, SkillLoadConfig, SkillPackageFile } from './types';
import { DEFAULT_SKILL_LOAD_CONFIG } from './types';
import { classifySkillPackageFile, enrichSkillPackageMetadata, getSkillPackageRoot } from './packageMetadata';
import { applyTrustOverride } from './skillTrustStorage';
import { hydrateSkillUiSettings } from './skillSettingsMirror';
import { skillFavorites } from './skillFavorites';
import { applyEnableOverride } from './skillEnableStorage';
import { refreshRequiresGates } from './requiresGating';
import { getBuiltinSkills } from './builtin';
import { restoreHostSkillSummaries } from './hostResources';
import {
  getAllBuiltinSkillCustomizations,
  applyCustomizationToSkill,
} from './builtinStorage';
import { getBuiltinToolSkills } from './builtin-tools';
import { isMobilePlatform, isWebUiShell } from '@/utils/platform';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

// ============================================================================
// 常量
// ============================================================================

const LOG_PREFIX = '[SkillLoader]';
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/**
 * SKILL.md 文件名
 */
const SKILL_FILE_NAME = 'SKILL.md';

/** 项目内兼容 Agent Skills 标准的目录（后者覆盖前者）。 */
const PROJECT_SKILL_DIRS = [
  '.skills',
  '.agents/skills',
  '.claude/skills',
  '.github/skills',
] as const;

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
 * - project skills 只能绑定到用户明确配置的 workspace runtime root；appData
 *   是应用数据目录，不是项目目录
 *
 * 约束：
 * - 开发环境保持旧行为（使用相对路径，便于在仓库根目录直接放置 .skills）
 * - 生产环境未配置 workspace 时返回 undefined，调用方跳过 project 扫描
 */
async function resolveDefaultProjectRootDir(): Promise<string | null | undefined> {
  // 开发环境保持原语义：相对路径直接交给后端 cwd 处理
  if (import.meta.env.DEV) return null;
  if (!isTauriRuntime()) return null;
  // 原生移动壳无 workspace runtime root，直接跳过 project skill 扫描避免触发 UNSUPPORTED_ON_PLATFORM 诊断错误
  if (isMobilePlatform() && !isWebUiShell()) return undefined;

  try {
    const roots = await invoke<Array<{
      id: string;
      path: string;
      configured: boolean;
    }>>('chat_v2_list_runtime_roots');
    const workspace = roots.find((root) =>
      root.id === 'workspace'
      && root.configured
      && typeof root.path === 'string'
      && root.path.trim().length > 0
    );
    if (workspace) return workspace.path;
    console.info(LOG_PREFIX, 'No configured workspace root; skipping project skill discovery');
    return undefined;
  } catch (error: unknown) {
    console.warn(LOG_PREFIX, 'Cannot resolve configured workspace root; skipping project skill discovery:', error);
    return undefined;
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

interface SkillPackageFileEntry {
  path: string;
  size: number;
}

interface DeclarativeSkillAsset {
  pluginId: string;
  skillId: string;
  name: string;
  description: string;
  markdown: string;
  sourcePath: string;
}

export interface SkillLoadStats {
  total: number;
  builtin: number;
  global: number;
  project: number;
  errors: number;
}

function extractErrorInfo(error: unknown): { code?: string; message: string } {
  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error) as { code?: unknown; message?: unknown };
      if (parsed && typeof parsed === 'object') {
        return {
          code: typeof parsed.code === 'string' ? parsed.code : undefined,
          message: typeof parsed.message === 'string' ? parsed.message : error,
        };
      }
    } catch {
      // Plain text error.
    }
    return { message: error };
  }
  if (error && typeof error === 'object') {
    const obj = error as { code?: unknown; message?: unknown };
    return {
      code: typeof obj.code === 'string' ? obj.code : undefined,
      message: typeof obj.message === 'string' ? obj.message : String(error),
    };
  }
  return { message: String(error) };
}

function isMissingSkillFileError(error: unknown): boolean {
  const { code, message } = extractErrorInfo(error);
  if (code === 'RESOURCE_NOT_FOUND' || code === 'ENOENT') return true;
  return /\b(?:RESOURCE_NOT_FOUND|ENOENT)\b|file not found|no such file/i.test(message);
}

function isMissingDirectoryError(error: unknown): boolean {
  const { code, message } = extractErrorInfo(error);
  if (code === 'RESOURCE_NOT_FOUND' || code === 'ENOENT') return true;
  return /\b(?:RESOURCE_NOT_FOUND|ENOENT)\b|directory not found|no such file or directory/i.test(message);
}

let loadGeneration = 0;
let activeLoadPromise: Promise<SkillLoadStats> | null = null;
let lastCommittedStats: SkillLoadStats | null = null;
let manifestRefreshListenerPromise: Promise<void> | null = null;

function ensurePluginManifestRefreshListener(): void {
  if (manifestRefreshListenerPromise || !isTauriRuntime()) return;
  manifestRefreshListenerPromise = import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen('host://ui-manifest-v2', () => {
        void reloadSkills().catch((error: unknown) => {
          console.warn(LOG_PREFIX, 'Failed to reload skills after host://ui-manifest-v2:', error);
        });
      }),
    )
    .then(() => undefined)
    .catch((error: unknown) => {
      manifestRefreshListenerPromise = null;
      console.debug(LOG_PREFIX, 'Unable to attach host://ui-manifest-v2 listener:', error);
    });
}

async function loadDeclarativePluginSkills(): Promise<SkillDefinition[]> {
  let assets: DeclarativeSkillAsset[];
  try {
    const result = await invoke<DeclarativeSkillAsset[]>('plugin:manager|declarative-skills', {});
    assets = Array.isArray(result) ? result : [];
  } catch (error: unknown) {
    // Non-Host / demo / unit-test environments may not expose this kernel command.
    console.debug(LOG_PREFIX, 'Declarative plugin skills unavailable:', error);
    return [];
  }

  const skills: SkillDefinition[] = [];
  for (const asset of assets) {
    if (
      !asset
      || typeof asset.pluginId !== 'string'
      || typeof asset.skillId !== 'string'
      || typeof asset.markdown !== 'string'
    ) {
      continue;
    }
    const cleanRelPath = (asset.sourcePath || `${asset.skillId}.md`).replace(/^\.\//, '');
    const virtualSourcePath = `plugin://${asset.pluginId}/${cleanRelPath}`;
    const parsed = parseSkillFile(asset.markdown, virtualSourcePath, asset.skillId, 'global');
    const baseSkill: SkillDefinition = parsed.success && parsed.skill
      ? {
          ...parsed.skill,
          name: parsed.skill.name || asset.name || asset.skillId,
          description: parsed.skill.description || asset.description || '',
          sourcePath: virtualSourcePath,
          packageRoot: `plugin://${asset.pluginId}`,
          packageSource: 'external',
          trustStatus: 'trusted',
          isBuiltin: false,
        }
      : {
          id: asset.skillId,
          name: asset.name || asset.skillId,
          description: asset.description || '',
          content: asset.markdown.trim(),
          location: 'global',
          sourcePath: virtualSourcePath,
          packageRoot: `plugin://${asset.pluginId}`,
          packageSource: 'external',
          trustStatus: 'trusted',
          isBuiltin: false,
        };
    skills.push(applyEnableOverride(applyTrustOverride(enrichSkillPackageMetadata(baseSkill))));
  }
  return skills;
}

async function loadPackageFiles(packageRoot: string): Promise<SkillPackageFile[] | undefined> {
  if (!packageRoot || packageRoot.startsWith('builtin://')) {
    return undefined;
  }

  try {
    const files = await invoke<SkillPackageFileEntry[]>('skill_list_package_files', {
      path: packageRoot,
    });
    return files.map((file) => ({
      path: file.path,
      kind: classifySkillPackageFile(file.path),
      size: file.size,
    }));
  } catch (error: unknown) {
    console.warn(LOG_PREFIX, 'Failed to index skill package files, using entry file only:', packageRoot, error);
    return undefined;
  }
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
): Promise<{ skills: SkillDefinition[]; errors: number }> {
  let errors = 0;

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

    // 每个 skill 目录独立：SKILL.md 读取 + 包文件索引并发发出。
    // 串行时 N 个 skill 就是 2N 次往返（公网 RTT 150–250ms 下 N=10 要几秒）。
    const loaded = await Promise.all(entries.map(async (entry) => {
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

        if (!parseResult.success || !parseResult.skill) {
          console.warn(
            LOG_PREFIX,
            `解析 skill 失败: ${entry.name}`,
            parseResult.error
          );
          return { name: entry.name, skill: null, warnings: null as string[] | null, failed: true };
        }

        const packageFiles = await loadPackageFiles(entry.path);
        const skill = applyEnableOverride(applyTrustOverride(
          enrichSkillPackageMetadata(parseResult.skill, packageFiles),
        ));
        console.log(
          LOG_PREFIX,
          `已加载 skill: ${parseResult.skill.name} (${entry.name})`
        );
        return {
          name: entry.name,
          skill,
          warnings: parseResult.warnings && parseResult.warnings.length > 0
            ? parseResult.warnings
            : null,
          failed: false,
        };
      } catch (readError: unknown) {
        if (isMissingSkillFileError(readError)) {
          // SKILL.md 不存在，跳过此目录（正常情况，不计入错误）
          console.debug(
            LOG_PREFIX,
            `目录 ${entry.name} 无 SKILL.md，跳过`
          );
          return { name: entry.name, skill: null, warnings: null, failed: false };
        }
        console.warn(
          LOG_PREFIX,
          `读取 skill 失败: ${entry.name}`,
          readError
        );
        return { name: entry.name, skill: null, warnings: null, failed: true };
      }
    }));

    const skills: SkillDefinition[] = [];
    for (const result of loaded) {
      if (result.failed) errors++;
      if (result.warnings) {
        console.warn(
          LOG_PREFIX,
          `${result.name} 警告:`,
          result.warnings.join('; ')
        );
      }
      if (result.skill) skills.push(result.skill);
    }

    return { skills, errors };
  } catch (error: unknown) {
    if (isMissingDirectoryError(error)) {
      console.debug(LOG_PREFIX, `目录不存在，跳过 ${dirPath}`);
      return { skills: [], errors: 0 };
    }
    console.warn(
      LOG_PREFIX,
      `无法访问目录 ${dirPath}:`,
      error
    );
    return { skills: [], errors: 1 };
  }
}

async function runSkillLoad(
  config: SkillLoadConfig,
  replace: boolean,
): Promise<SkillLoadStats> {
  const generation = ++loadGeneration;
  ensurePluginManifestRefreshListener();

  const currentPromise = (async (): Promise<SkillLoadStats> => {
    const mergedConfig = { ...DEFAULT_SKILL_LOAD_CONFIG, ...config };
    const stats: SkillLoadStats = { total: 0, builtin: 0, global: 0, project: 0, errors: 0 };

    console.log(LOG_PREFIX, replace ? 'Reloading skills...' : 'Loading skills...');

    // 0. 把 localStorage 里的四个技能 UI 状态与主库 settings 对齐（后端有值优先，后端为空时上送本地值）。
    //    失败只告警：localStorage 仍是渲染期的同步读源。
    try {
      await hydrateSkillUiSettings();
      skillFavorites.reload();
    } catch (error: unknown) {
      console.warn(LOG_PREFIX, 'Failed to hydrate skill UI settings from backend:', error);
    }

    // 1. 暂存内置 skills（最低优先级，不中途清空/修改 registry）
    const stagedBuiltin: SkillDefinition[] = [];
    if (mergedConfig.loadBuiltin !== false) {
      try {
        const builtinSkills = getBuiltinSkills();
        const builtinIds = builtinSkills.map((s) => s.id);

        // 加载用户对内置 skills 的自定义数据
        const customizations = await getAllBuiltinSkillCustomizations(builtinIds);
        const customizedCount = customizations.size;

        for (const skill of builtinSkills) {
          const customization = customizations.get(skill.id) ?? null;
          const finalSkill = applyEnableOverride(applyTrustOverride(
            enrichSkillPackageMetadata(applyCustomizationToSkill(skill, customization)),
          ));
          stagedBuiltin.push(finalSkill);
          stats.builtin++;
        }

        // 加载内置工具组 Skills（渐进披露架构）
        const builtinToolSkills = getBuiltinToolSkills();
        for (const skill of builtinToolSkills) {
          stagedBuiltin.push(applyEnableOverride(applyTrustOverride(enrichSkillPackageMetadata(skill))));
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

    // 2. 并行加载声明式插件 skills、全局 skills 与项目 skills
    const declarativeLoadPromise = loadDeclarativePluginSkills();

    const globalLoadPromise = (async () => {
      if (!mergedConfig.globalPath) return null;
      try {
        return await loadSkillsFromDirectory(mergedConfig.globalPath, 'global');
      } catch (error: unknown) {
        console.error(LOG_PREFIX, 'Failed to load global skills:', error);
        return 'failed' as const;
      }
    })();

    const projectLoadPromise = (async () => {
      const defaultProjectRootDir = !mergedConfig.projectRootDir
        ? await resolveDefaultProjectRootDir()
        : null;
      const effectiveProjectRootDir = mergedConfig.projectRootDir ?? defaultProjectRootDir;
      if (effectiveProjectRootDir === undefined) return [];

      const dirsToScan: string[] = [...PROJECT_SKILL_DIRS];
      if (mergedConfig.projectPath && !dirsToScan.includes(mergedConfig.projectPath)) {
        dirsToScan.push(mergedConfig.projectPath);
      }

      const projectPaths = dirsToScan.map((relDir) => (
        effectiveProjectRootDir
        && !relDir.startsWith('/')
        && !relDir.startsWith('~')
          ? `${effectiveProjectRootDir}/${relDir}`
          : relDir
      ));
      return Promise.all(projectPaths.map((path) => loadSkillsFromDirectory(path, 'project')));
    })().catch((error: unknown) => {
      console.error(LOG_PREFIX, 'Failed to load project skills:', error);
      return 'failed' as const;
    });

    const [declarativeSkills, globalResult, projectResults] = await Promise.all([
      declarativeLoadPromise,
      globalLoadPromise,
      projectLoadPromise,
    ]);

    // 代际门控：若有更新的重载已经发起，丢弃本次过时快照，等待最新重载完成再返回，绝不回写旧状态。
    if (generation !== loadGeneration) {
      if (activeLoadPromise && activeLoadPromise !== currentPromise) {
        return activeLoadPromise;
      }
      return lastCommittedStats ?? stats;
    }

    const staged: SkillDefinition[] = [...stagedBuiltin, ...declarativeSkills];

    if (globalResult === 'failed') {
      stats.errors++;
    } else if (globalResult) {
      stats.errors += globalResult.errors;
      for (const skill of globalResult.skills) {
        staged.push(applyEnableOverride(applyTrustOverride(skill)));
        stats.global++;
      }
    }

    if (projectResults === 'failed') {
      stats.errors++;
    } else {
      for (const projectResult of projectResults) {
        stats.errors += projectResult.errors;
        for (const skill of projectResult.skills) {
          staged.push(skill);
          stats.project++;
        }
      }
    }

    // 原子同步提交：整个 registry 切换在同一个微任务内完成，不出现异步空窗期。
    if (replace) {
      const prevIds = skillRegistry.getAll().map((skill) => skill.id);
      const stagedIds = new Set(staged.map((skill) => skill.id));
      if (staged.length > 0) {
        skillRegistry.registerMany(staged);
      }
      for (const existingId of prevIds) {
        if (!stagedIds.has(existingId)) {
          skillRegistry.unregister(existingId);
        }
      }
    } else if (staged.length > 0) {
      skillRegistry.registerMany(staged);
    }
    restoreHostSkillSummaries();

    stats.total = skillRegistry.size;
    lastCommittedStats = { ...stats };

    console.log(
      LOG_PREFIX,
      `加载完成: 内置=${stats.builtin}, 插件=${declarativeSkills.length}, 全局=${stats.global}, 项目=${stats.project}, 总计=${stats.total}`
    );

    // 加载期 requires 门控：重新探测带 requires 声明技能的本机满足情况，
    // 不满足的技能不进入 <available_skills> 推荐（探测失败 fail-open）
    if (generation === loadGeneration) {
      try {
        await refreshRequiresGates(skillRegistry.getAll());
      } catch (error: unknown) {
        console.warn(LOG_PREFIX, 'requires gating probe failed:', error);
      }
    }

    return stats;
  })();

  activeLoadPromise = currentPromise;
  try {
    return await currentPromise;
  } finally {
    if (activeLoadPromise === currentPromise) {
      activeLoadPromise = null;
    }
  }
}

/**
 * 从文件系统加载所有 skills
 *
 * 按顺序加载（优先级从低到高）：
 * 1. 内置 skills（builtin）- 最低优先级
 * 2. 已启用声明式插件（.dspack）skills
 * 3. 全局 skills（~/.deep-student/skills）
 * 4. 项目 skills（.skills）- 最高优先级
 *
 * 后加载的 skills 会覆盖同 ID 的先加载 skills
 *
 * @param config 加载配置
 * @returns 加载结果统计
 */
export async function loadSkillsFromFileSystem(
  config: SkillLoadConfig = {}
): Promise<SkillLoadStats> {
  return runSkillLoad(config, false);
}

/**
 * 重新加载所有 skills
 *
 * 采用单飞代际门控与原子替换（不中途清空 registry），避免并发重载互相抹掉刚保存的技能。
 *
 * @param config 加载配置
 * @returns 加载结果统计
 */
export async function reloadSkills(
  config?: SkillLoadConfig
): Promise<SkillLoadStats> {
  return runSkillLoad(config ?? {}, true);
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
      const packageRoot = getSkillPackageRoot(fileResult.path);
      const packageFiles = packageRoot ? await loadPackageFiles(packageRoot) : undefined;
      const skill = applyEnableOverride(applyTrustOverride(enrichSkillPackageMetadata(parseResult.skill, packageFiles)));
      skillRegistry.register(skill);
      console.log(LOG_PREFIX, `Loaded single skill: ${skill.name}`);
      return true;
    }

    console.warn(LOG_PREFIX, `Failed to parse skill:`, parseResult.error);
    return false;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, `Failed to load skill:`, error);
    return false;
  }
}
