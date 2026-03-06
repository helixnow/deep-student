/**
 * Chat V2 - Skills 渐进披露核心模块
 *
 * 实现 Skills 渐进披露架构：
 * - load_skills 元工具定义
 * - 已加载 Skills 状态管理
 * - 工具 Schema 动态注入
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { ToolSchema } from './types';
import { skillRegistry } from './registry';

// ============================================================================
// 常量
// ============================================================================

const LOG_PREFIX = '[ProgressiveDisclosure]';

// ============================================================================
// XML 安全辅助函数
// ============================================================================

/**
 * 转义 XML 属性中的特殊字符
 *
 * 防止通过 skill.id 等字段注入恶意 XML 属性或标签。
 * 转义字符: < > & " '
 */
export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 转义 XML 文本内容中的特殊字符
 *
 * 用于工具名称、描述等短文本。
 * 转义字符: < > &
 */
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 将内容包裹在 CDATA 段中
 *
 * 用于 Skill 指令内容等可能包含 XML 特殊字符的长文本。
 * 处理内容中可能出现的 "]]>" 序列（CDATA 结束标记），
 * 将其拆分为多个 CDATA 段以安全嵌入。
 */
export function wrapCDATA(content: string): string {
  // CDATA 中不能出现 "]]>"，需要拆分处理
  const safe = content.replace(/]]>/g, ']]]]><![CDATA[>');
  return `<![CDATA[${safe}]]>`;
}

/** load_skills 元工具名称 */
export const LOAD_SKILLS_TOOL_NAME = 'load_skills';

// ============================================================================
// load_skills 元工具 Schema
// ============================================================================

/**
 * load_skills 元工具 Schema
 *
 * 这是渐进披露架构中唯一在首轮请求中预加载的工具。
 * LLM 通过调用此工具来加载所需的技能组。
 */
export const LOAD_SKILLS_TOOL_SCHEMA: {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
} = {
  name: LOAD_SKILLS_TOOL_NAME,
  description: `加载指定的技能组以获取对应的工具能力。

当你需要执行某项任务但没有合适的工具时，请先查看 <available_skills> 列表，选择相关的技能并加载。
加载技能后，你将获得该技能提供的工具，可以用来完成任务。

可以一次加载多个技能。加载后的技能在整个会话中保持有效。`,
  inputSchema: {
    type: 'object',
    properties: {
      skills: {
        type: 'array',
        items: { type: 'string' },
        description: '要加载的技能 ID 列表，参考 <available_skills> 中的技能 ID',
      },
    },
    required: ['skills'],
  },
};

// ============================================================================
// 会话已加载 Skills 状态管理
// ============================================================================

/**
 * 已加载的 Skill 信息
 */
export interface LoadedSkillInfo {
  /** Skill ID */
  id: string;
  /** Skill 名称 */
  name: string;
  /** 该 Skill 提供的工具 Schema */
  tools: ToolSchema[];
  /** 加载时间 */
  loadedAt: number;
}

/**
 * 会话级别的已加载 Skills 状态
 *
 * 使用 Map 存储，key 为 sessionId。
 *
 * 内存释放策略：
 * - 会话被销毁/淘汰时由 SessionManager 调用 clearSessionSkills() 清理
 */
const loadedSkillsMap = new Map<string, Map<string, LoadedSkillInfo>>();

// ============================================================================
// 订阅机制 - 用于 UI 实时响应技能加载状态变化
// ============================================================================

type LoadedSkillsListener = (sessionId: string, loadedSkillIds: string[]) => void;
const listeners = new Set<LoadedSkillsListener>();

/** 监听器数量上限，防止订阅泄漏 */
const MAX_LISTENERS = 100;

/**
 * 订阅已加载技能状态变化
 * @param listener 监听函数
 * @returns 取消订阅函数
 */
export function subscribeToLoadedSkills(listener: LoadedSkillsListener): () => void {
  if (listeners.size >= MAX_LISTENERS) {
    console.warn(LOG_PREFIX, `Listener count reached limit (${MAX_LISTENERS}), possible subscription leak`);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 通知所有监听器状态变化
 */
function notifyListeners(sessionId: string): void {
  const skillIds = Array.from(loadedSkillsMap.get(sessionId)?.keys() ?? []);
  listeners.forEach(listener => {
    try {
      listener(sessionId, skillIds);
    } catch (e: unknown) {
      console.error(LOG_PREFIX, 'Listener execution error:', e);
    }
  });
}

/**
 * 获取会话已加载的 Skills
 */
export function getLoadedSkills(sessionId: string): LoadedSkillInfo[] {
  const sessionSkills = loadedSkillsMap.get(sessionId);
  if (!sessionSkills) {
    return [];
  }
  return Array.from(sessionSkills.values());
}

/**
 * 获取会话已加载的所有工具 Schema
 */
export function getLoadedToolSchemas(sessionId: string): ToolSchema[] {
  const skills = getLoadedSkills(sessionId);
  const tools: ToolSchema[] = [];
  for (const skill of skills) {
    tools.push(...skill.tools);
  }
  return tools;
}

/**
 * 检查 Skill 是否已加载
 */
export function isSkillLoaded(sessionId: string, skillId: string): boolean {
  const sessionSkills = loadedSkillsMap.get(sessionId);
  return sessionSkills?.has(skillId) ?? false;
}

/**
 * 加载 Skills 到会话
 *
 * @param sessionId 会话 ID
 * @param skillIds 要加载的 Skill ID 列表
 * @returns 加载结果
 */
export function loadSkillsToSession(
  sessionId: string,
  skillIds: string[]
): {
  loaded: LoadedSkillInfo[];
  alreadyLoaded: string[];
  notFound: string[];
} {
  // 确保会话状态存在
  if (!loadedSkillsMap.has(sessionId)) {
    loadedSkillsMap.set(sessionId, new Map());
  }
  const sessionSkills = loadedSkillsMap.get(sessionId)!;

  const loaded: LoadedSkillInfo[] = [];
  const alreadyLoaded: string[] = [];
  const notFound: string[] = [];

  // 收集所有需要加载的 skills（包括依赖）
  const toLoad: string[] = [];
  const visited = new Set<string>();

  // 递归收集依赖（含循环依赖检测）
  function collectDependencies(id: string, path: string[] = []): void {
    // 检测循环依赖
    if (path.includes(id)) {
      console.warn(LOG_PREFIX, `Circular dependency detected: ${path.join(' → ')} → ${id}`);
      return;
    }

    if (visited.has(id)) return;
    visited.add(id);

    const skill = skillRegistry.get(id);
    if (!skill) {
      console.warn(LOG_PREFIX, `Skill not found: ${id}`);
      return;
    }

    // 先加载依赖，传递当前路径
    if (skill.dependencies && skill.dependencies.length > 0) {
      for (const depId of skill.dependencies) {
        collectDependencies(depId, [...path, id]);
      }
    }

    // 再加载自身
    toLoad.push(id);
  }

  // 收集所有请求的 skills 及其依赖
  for (const skillId of skillIds) {
    collectDependencies(skillId);
  }

  // 按顺序加载（依赖在前）
  for (const skillId of toLoad) {
    // 检查是否已加载
    if (sessionSkills.has(skillId)) {
      if (skillIds.includes(skillId)) {
        alreadyLoaded.push(skillId);
      }
      continue;
    }

    // 从 registry 获取 Skill 定义
    const skill = skillRegistry.get(skillId);
    if (!skill) {
      console.warn(LOG_PREFIX, `Skill not found: ${skillId}`);
      if (skillIds.includes(skillId)) {
        notFound.push(skillId);
      }
      continue;
    }

    // 检查是否有 embeddedTools
    if (!skill.embeddedTools || skill.embeddedTools.length === 0) {
      console.warn(LOG_PREFIX, `Skill ${skillId} has no embeddedTools defined`);
      // 仍然加载，但没有工具
    }

    const info: LoadedSkillInfo = {
      id: skillId,
      name: skill.name,
      tools: skill.embeddedTools ?? [],
      loadedAt: Date.now(),
    };

    sessionSkills.set(skillId, info);
    loaded.push(info);
    
    const isDep = !skillIds.includes(skillId);
    console.log(LOG_PREFIX, `Loaded skill: ${skillId}${isDep ? ' (dependency)' : ''}, tools: ${info.tools.length}`);
  }

  // 通知订阅者
  if (loaded.length > 0) {
    notifyListeners(sessionId);
  }

  return { loaded, alreadyLoaded, notFound };
}

/**
 * 用后端权威状态同步会话已加载 Skills。
 *
 * `replace=true` 时，以后端返回的完整列表覆盖本地缓存；
 * `replace=false` 时，仅在本地补齐缺失项。
 */
export function syncLoadedSkillsFromBackend(
  sessionId: string,
  skillIds: string[],
  options: { replace?: boolean } = {}
): ReturnType<typeof loadSkillsToSession> {
  const normalizedSkillIds = skillIds.filter((id): id is string => typeof id === 'string' && id.length > 0);

  if (options.replace) {
    clearSessionSkills(sessionId);
  }

  if (normalizedSkillIds.length === 0) {
    return { loaded: [], alreadyLoaded: [], notFound: [] };
  }

  return loadSkillsToSession(sessionId, normalizedSkillIds);
}

/**
 * 清除会话的所有已加载 Skills
 */
export function clearSessionSkills(sessionId: string): void {
  const hadSkills = loadedSkillsMap.has(sessionId) && (loadedSkillsMap.get(sessionId)?.size ?? 0) > 0;
  loadedSkillsMap.delete(sessionId);
  console.log(LOG_PREFIX, `Cleared all loaded skills for session ${sessionId}`);
  // 通知订阅者
  if (hadSkills) {
    notifyListeners(sessionId);
  }
}

/**
 * 卸载指定 Skill
 */
export function unloadSkill(sessionId: string, skillId: string): boolean {
  const sessionSkills = loadedSkillsMap.get(sessionId);
  if (!sessionSkills) {
    return false;
  }
  const result = sessionSkills.delete(skillId);
  if (result) {
    console.log(LOG_PREFIX, `Unloaded skill: ${skillId}`);
    // 通知订阅者
    notifyListeners(sessionId);
  }
  return result;
}

// ============================================================================
// load_skills 工具调用处理
// ============================================================================

/**
 * 处理 load_skills 工具调用
 *
 * 返回格式化的 tool_result 内容
 *
 * @param sessionId 会话 ID
 * @param args 工具调用参数
 * @returns tool_result 内容
 */
export function handleLoadSkillsToolCall(
  sessionId: string,
  args: { skills?: unknown }
): string {
  // 🔧 入参类型校验：args.skills 可能是非数组值（如字符串、null、数字）
  let skillIds: string[];
  if (Array.isArray(args.skills)) {
    skillIds = args.skills.filter(
      (item): item is string => typeof item === 'string' && item.length > 0
    );
  } else if (typeof args.skills === 'string') {
    // 兼容 LLM 可能传递单个字符串而非数组
    skillIds = args.skills.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    skillIds = [];
  }

  if (skillIds.length === 0) {
    return '<error>请指定要加载的技能 ID 列表</error>';
  }

  const { loaded, alreadyLoaded, notFound } = loadSkillsToSession(sessionId, skillIds);

  // 构建响应
  const parts: string[] = [];

  // 已加载的 Skills
  for (const skill of loaded) {
    parts.push(`<skill_loaded id="${escapeXmlAttr(skill.id)}">`);
    
    // 获取完整的 Skill 定义以获取 content
    const fullSkill = skillRegistry.get(skill.id);
    if (fullSkill?.content) {
      parts.push(`<instructions>`);
      parts.push(wrapCDATA(fullSkill.content));
      parts.push(`</instructions>`);
    }
    
    // 列出可用工具
    if (skill.tools.length > 0) {
      parts.push(`<available_tools>`);
      for (const tool of skill.tools) {
        parts.push(`  - ${escapeXmlText(tool.name)}: ${escapeXmlText(tool.description)}`);
      }
      parts.push(`</available_tools>`);
    }
    
    parts.push(`</skill_loaded>`);
  }

  // 已经加载过的提示
  if (alreadyLoaded.length > 0) {
    parts.push(`<info>以下技能已加载，无需重复加载: ${alreadyLoaded.join(', ')}</info>`);
  }

  // 未找到的提示
  if (notFound.length > 0) {
    parts.push(`<warning>以下技能未找到: ${notFound.join(', ')}</warning>`);
  }

  // 加载统计
  if (loaded.length > 0) {
    const totalTools = loaded.reduce((sum, s) => sum + s.tools.length, 0);
    parts.push(`\n共加载 ${loaded.length} 个技能，包含 ${totalTools} 个工具。这些工具现在可以使用了。`);
  }

  return parts.join('\n');
}

// ============================================================================
// available_skills 元数据生成
// ============================================================================

/**
 * 生成 available_skills XML 元数据
 *
 * 用于注入到 System Prompt 中，告知 LLM 可用的技能列表
 *
 * @param excludeLoaded 是否排除已加载的 Skills
 * @param sessionId 会话 ID（用于检查已加载状态）
 */
export function generateAvailableSkillsPrompt(
  excludeLoaded = false,
  sessionId?: string
): string {
  const skills = skillRegistry.getAll();

  // 过滤掉 disableAutoInvoke 的 Skills
  let filteredSkills = skills.filter(s => !s.disableAutoInvoke);

  // 允许无 embeddedTools 的模式型 Skills（如 research-mode），工具数量为 0

  // 如果需要排除已加载的
  if (excludeLoaded && sessionId) {
    const loadedIds = new Set(getLoadedSkills(sessionId).map(s => s.id));
    filteredSkills = filteredSkills.filter(s => !loadedIds.has(s.id));
  }

  if (filteredSkills.length === 0) {
    return '';
  }

  const lines: string[] = ['<available_skills>'];

  for (const skill of filteredSkills) {
    const toolCount = skill.embeddedTools?.length ?? 0;
    lines.push(`  <skill id="${escapeXmlAttr(skill.id)}" tools="${toolCount}">`);
    lines.push(`    ${escapeXmlText(skill.description)}`);
    lines.push(`  </skill>`);
  }

  lines.push('</available_skills>');
  lines.push('');
  lines.push('当你需要使用某种能力但没有对应工具时，请先通过 load_skills 工具加载相关技能。');
  lines.push('');
  lines.push('<tool_calling_rules>');
  lines.push('【重要】所有技能组中包含的工具必须通过正常的工具调用方式使用，不要直接输出 JSON 文本。调用时请严格遵循技能文档中的参数格式示例。');
  lines.push('</tool_calling_rules>');

  return lines.join('\n');
}

// ============================================================================
// 渐进披露模式配置
// ============================================================================

/**
 * 渐进披露模式配置
 */
export interface ProgressiveDisclosureConfig {
  /** 自动加载的 Skill ID 列表 */
  autoLoadSkills: string[];
  /** 是否回退到预加载所有工具模式 */
  preloadAllTools: boolean;
}

/**
 * 默认配置
 *
 * 渐进披露模式始终启用，完全替代 builtinMcpServer.ts
 * 所有内置工具通过 Skills 按需加载
 */
export const DEFAULT_PROGRESSIVE_DISCLOSURE_CONFIG: ProgressiveDisclosureConfig = {
  autoLoadSkills: ['mindmap-tools'], // 自动加载思维导图技能（会自动加载依赖的 learning-resource）
  preloadAllTools: false,
};

let currentConfig: ProgressiveDisclosureConfig = { ...DEFAULT_PROGRESSIVE_DISCLOSURE_CONFIG };

/**
 * 获取当前配置
 */
export function getProgressiveDisclosureConfig(): ProgressiveDisclosureConfig {
  return { ...currentConfig };
}

