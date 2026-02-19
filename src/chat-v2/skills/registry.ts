/**
 * Chat V2 - Skills 注册表
 *
 * 管理所有加载的 Skills，提供注册、查询、元数据生成等功能
 *
 * 设计说明：
 * - 单例模式，全局唯一
 * - 支持从文件系统加载 skills
 * - 支持生成 LLM 元数据 prompt（用于自动激活推荐）
 * - 与 contextTypeRegistry 配合，提供 ContextRef 创建能力
 */

import type {
  SkillDefinition,
  SkillMetadata,
  SkillLocation,
  SkillLoadConfig,
} from './types';
import { SKILL_INSTRUCTION_TYPE_ID, SKILL_DEFAULT_PRIORITY } from './types';
import { debugLog } from '../../debug-panel/debugMasterSwitch';
import i18n from 'i18next';

// ============================================================================
// 常量
// ============================================================================

const LOG_PREFIX = '[SkillRegistry]';
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

// ============================================================================
// 更新通知机制
// ============================================================================

/** 更新监听器类型 */
type RegistryUpdateListener = () => void;

/** 监听器数量上限，超过则警告可能的订阅泄漏 */
const MAX_LISTENERS = 100;

/** 全局更新监听器列表 */
const updateListeners = new Set<RegistryUpdateListener>();

/**
 * 订阅 registry 更新
 * @param listener 监听器
 * @returns 取消订阅函数
 */
export function subscribeToSkillRegistry(listener: RegistryUpdateListener): () => void {
  if (updateListeners.size >= MAX_LISTENERS) {
    console.warn('[SkillRegistry] Listener count at limit (' + MAX_LISTENERS + '), possible subscription leak');
  }
  updateListeners.add(listener);
  return () => {
    updateListeners.delete(listener);
  };
}

/**
 * 通知所有监听器 registry 已更新
 */
function notifyUpdate(): void {
  updateListeners.forEach((listener) => {
    try {
      listener();
    } catch (error: unknown) {
      console.error(LOG_PREFIX, 'Listener execution failed:', error);
    }
  });
}

// ============================================================================
// SkillRegistry 类
// ============================================================================

/**
 * Skills 注册表
 *
 * 职责：
 * 1. 管理所有已加载的 skills
 * 2. 提供 skill 查询和元数据访问
 * 3. 生成 available_skills 元数据（注入 system prompt）
 * 4. 创建 skill 的 ContextRef（用于激活）
 */
class SkillRegistry {
  /** 已注册的 skills */
  private skills: Map<string, SkillDefinition> = new Map();

  /** 初始化状态 */
  private initialized = false;

  /** 加载配置 */
  private loadConfig: SkillLoadConfig = {};

  // ==========================================================================
  // 注册与查询
  // ==========================================================================

  /**
   * 注册 skill
   *
   * @param skill Skill 定义
   */
  register(skill: SkillDefinition): void {
    if (this.skills.has(skill.id)) {
      console.warn(LOG_PREFIX, `Skill "${skill.id}" already exists, will be overwritten`);
    }

    this.skills.set(skill.id, skill);
    console.log(LOG_PREFIX, `Registered skill: ${skill.id} (${skill.name})`);
    notifyUpdate();
  }

  /**
   * 批量注册 skills
   *
   * @param skills Skill 定义列表
   */
  registerMany(skills: SkillDefinition[]): void {
    for (const skill of skills) {
      // 内部注册，不触发通知
      if (this.skills.has(skill.id)) {
        console.warn(LOG_PREFIX, `Skill "${skill.id}" already exists, will be overwritten`);
      }
      this.skills.set(skill.id, skill);
      console.log(LOG_PREFIX, `Registered skill: ${skill.id} (${skill.name})`);
    }
    // 批量完成后统一通知
    if (skills.length > 0) {
      notifyUpdate();
    }
  }

  /**
   * 注销 skill
   *
   * @param skillId Skill ID
   * @returns 是否成功注销
   */
  unregister(skillId: string): boolean {
    const result = this.skills.delete(skillId);
    if (result) {
      console.log(LOG_PREFIX, `Unregistered skill: ${skillId}`);
      notifyUpdate();
    }
    return result;
  }

  /**
   * 清空所有 skills
   */
  clear(): void {
    const hadSkills = this.skills.size > 0;
    this.skills.clear();
    console.log(LOG_PREFIX, 'Cleared all skills');
    if (hadSkills) {
      notifyUpdate();
    }
  }

  /**
   * 获取 skill
   *
   * @param skillId Skill ID
   * @returns Skill 定义或 undefined
   */
  get(skillId: string): SkillDefinition | undefined {
    return this.skills.get(skillId);
  }

  /**
   * 检查 skill 是否存在
   *
   * @param skillId Skill ID
   */
  has(skillId: string): boolean {
    return this.skills.has(skillId);
  }

  /**
   * 获取所有 skills
   *
   * @returns Skill 定义列表（按优先级排序）
   */
  getAll(): SkillDefinition[] {
    return Array.from(this.skills.values()).sort(
      (a, b) => (a.priority ?? SKILL_DEFAULT_PRIORITY) - (b.priority ?? SKILL_DEFAULT_PRIORITY)
    );
  }

  /**
   * 获取所有 skill 元数据（不含内容）
   *
   * @returns Skill 元数据列表
   */
  getAllMetadata(): SkillMetadata[] {
    return this.getAll().map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      author: skill.author,
      priority: skill.priority,
      allowedTools: skill.allowedTools,
      tools: skill.tools,
      disableAutoInvoke: skill.disableAutoInvoke,
      embeddedTools: skill.embeddedTools,
      skillType: skill.skillType,
      relatedSkills: skill.relatedSkills,
      dependencies: skill.dependencies,
    }));
  }

  /**
   * 按位置筛选 skills
   *
   * @param location 来源位置
   * @returns 符合条件的 skills
   */
  getByLocation(location: SkillLocation): SkillDefinition[] {
    return this.getAll().filter((skill) => skill.location === location);
  }

  /**
   * 获取 skills 数量
   */
  get size(): number {
    return this.skills.size;
  }

  // ==========================================================================
  // 元数据 Prompt 生成
  // ==========================================================================

  /**
   * 生成元数据 Prompt
   *
   * 注入到 system prompt，告知 LLM 可用的 skills
   * 用于支持 LLM 自动激活推荐
   *
   * @returns 格式化的元数据 prompt
   */
  generateMetadataPrompt(): string {
    // 过滤掉禁用自动调用的 skills
    const autoInvokeSkills = this.getAllMetadata().filter(
      (skill) => !skill.disableAutoInvoke
    );

    if (autoInvokeSkills.length === 0) {
      return '';
    }

    // 生成技能列表
    const skillList = autoInvokeSkills
      .map((skill) => {
        let line = `- **${skill.name}** (id: \`${skill.id}\`)`;
        if (skill.description) {
          line += `: ${skill.description}`;
        }
        return line;
      })
      .join('\n');

    return `<available_skills>
## 可用技能

以下技能可根据用户请求激活。当用户的问题明显匹配某个技能时，建议在回复中推荐激活该技能：

${skillList}

激活方式：
- 用户可通过 /skill <id> 命令手动激活
- 激活后技能指令会自动注入到后续对话

注意：
- 支持同时激活多个技能，根据需要组合使用
- 技能激活后持续生效直到用户取消
</available_skills>`;
  }

  /**
   * 生成简短的技能摘要（用于 UI 显示）
   *
   * @returns 技能摘要字符串
   */
  generateSummary(): string {
    const count = this.skills.size;
    if (count === 0) {
      return i18n.t('chatV2:skills.noSkillsLoaded', { defaultValue: 'No skills loaded' });
    }

    const locations = {
      global: this.getByLocation('global').length,
      project: this.getByLocation('project').length,
      builtin: this.getByLocation('builtin').length,
    };

    const parts: string[] = [];
    if (locations.global > 0) parts.push(`${i18n.t('chatV2:skills.locationGlobal', { defaultValue: 'global' })} ${locations.global}`);
    if (locations.project > 0) parts.push(`${i18n.t('chatV2:skills.locationProject', { defaultValue: 'project' })} ${locations.project}`);
    if (locations.builtin > 0) parts.push(`${i18n.t('chatV2:skills.locationBuiltin', { defaultValue: 'builtin' })} ${locations.builtin}`);

    return i18n.t('chatV2:skills.loadedSummary', {
      count,
      details: parts.join(', '),
      defaultValue: `Loaded ${count} skills (${parts.join(', ')})`,
    });
  }

  // ==========================================================================
  // 初始化和加载
  // ==========================================================================

  /**
   * 设置加载配置
   *
   * @param config 加载配置
   */
  setLoadConfig(config: SkillLoadConfig): void {
    this.loadConfig = config;
  }

  /**
   * 获取当前加载配置
   */
  getLoadConfig(): SkillLoadConfig {
    return { ...this.loadConfig };
  }

  /**
   * 标记为已初始化
   */
  markInitialized(): void {
    this.initialized = true;
    // 🔧 通知所有等待初始化的 Promise
    for (const resolve of this._initWaiters) {
      resolve();
    }
    this._initWaiters = [];
  }

  /** 等待初始化完成的回调列表 */
  private _initWaiters: Array<() => void> = [];

  /** Skills 是否已加载完成（区别于 initialized：initialized 只表示上下文类型已注册） */
  private _skillsLoaded = false;

  /** 等待 skills 加载完成的回调列表 */
  private _skillsLoadedWaiters: Array<() => void> = [];

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 等待 registry 初始化完成
   *
   * 如果已初始化则立即 resolve，否则等待 markInitialized() 被调用。
   * 带超时保护，防止无限等待。
   *
   * @param timeoutMs 超时时间（默认 5000ms）
   * @returns 是否在超时内初始化完成
   */
  waitForInitialized(timeoutMs = 5000): Promise<boolean> {
    if (this.initialized) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // 超时：从等待列表中移除并 resolve false
        this._initWaiters = this._initWaiters.filter((r) => r !== onInit);
        resolve(false);
      }, timeoutMs);

      const onInit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this._initWaiters.push(onInit);
    });
  }

  /**
   * 标记 skills 已加载完成
   *
   * 在 loadSkillsFromFileSystem 完成后调用，
   * 通知所有等待 skills 加载的消费者。
   */
  markSkillsLoaded(): void {
    this._skillsLoaded = true;
    for (const resolve of this._skillsLoadedWaiters) {
      resolve();
    }
    this._skillsLoadedWaiters = [];
  }

  /**
   * 等待 skills 加载完成
   *
   * 如果已加载则立即 resolve，否则等待 markSkillsLoaded() 被调用。
   * 带超时保护，防止无限等待。
   *
   * @param timeoutMs 超时时间（默认 3000ms）
   * @returns 是否在超时内加载完成
   */
  waitForSkillsLoaded(timeoutMs = 3000): Promise<boolean> {
    if (this._skillsLoaded) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this._skillsLoadedWaiters = this._skillsLoadedWaiters.filter((r) => r !== onLoaded);
        resolve(false);
      }, timeoutMs);

      const onLoaded = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this._skillsLoadedWaiters.push(onLoaded);
    });
  }

  /**
   * 重置状态（用于测试）
   */
  reset(): void {
    this.skills.clear();
    this.initialized = false;
    this._initWaiters = [];
    this._skillsLoaded = false;
    this._skillsLoadedWaiters = [];
    this.loadConfig = {};
    console.log(LOG_PREFIX, 'Registry reset');
  }
}

// ============================================================================
// 单例导出
// ============================================================================

/**
 * Skills 注册表单例
 */
export const skillRegistry = new SkillRegistry();

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 获取 skill 的 ContextRef 类型 ID
 */
export function getSkillContextTypeId(): string {
  return SKILL_INSTRUCTION_TYPE_ID;
}

/**
 * 根据 skill ID 查找并返回 skill（便捷函数）
 */
export function getSkill(skillId: string): SkillDefinition | undefined {
  return skillRegistry.get(skillId);
}

/**
 * 获取所有可自动激活的 skills
 */
export function getAutoInvokeSkills(): SkillMetadata[] {
  return skillRegistry.getAllMetadata().filter((skill) => !skill.disableAutoInvoke);
}
