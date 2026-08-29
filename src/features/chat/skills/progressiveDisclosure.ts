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
import { getRequiresGate, isSkillRequiresSatisfied } from './requiresGating';
import {
  getSkillRuntimeAdmission,
  isSkillPromptVisible,
  type SkillRuntimeAdmissionCode,
} from './runtimeAdmission';

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

export interface SkillLoadRejection {
  skillId: string;
  code: SkillRuntimeAdmissionCode | 'dependency_unavailable';
  message: string;
}

export interface SkillSessionLoadResult {
  loaded: LoadedSkillInfo[];
  alreadyLoaded: string[];
  notFound: string[];
  rejected: SkillLoadRejection[];
}

/**
 * 会话级别的已加载 Skills 状态
 *
 * 使用 Map 存储，key 为 sessionId。
 *
 * 内存释放策略：
 * - 会话被销毁/淘汰时由 SessionManager 调用 clearSessionSkills() 清理
 * - LRU 上限：超过 MAX_TRACKED_SESSIONS 时淘汰最早的会话
 */
const loadedSkillsMap = new Map<string, Map<string, LoadedSkillInfo>>();

/** LRU 上限，防止长期运行时内存无限增长 */
const MAX_TRACKED_SESSIONS = 20;

/**
 * LRU 方式设置会话 Skills 缓存
 * - 已存在的 key 先删除再重新插入（移到末尾，保持 LRU 顺序）
 * - 超过上限时淘汰最早的会话
 */
function setLoadedSkillsForSession(sessionId: string, skills: Map<string, LoadedSkillInfo>): void {
  if (loadedSkillsMap.has(sessionId)) {
    loadedSkillsMap.delete(sessionId);
  } else if (loadedSkillsMap.size >= MAX_TRACKED_SESSIONS) {
    const oldest = loadedSkillsMap.keys().next().value;
    if (oldest !== undefined) loadedSkillsMap.delete(oldest);
  }
  loadedSkillsMap.set(sessionId, skills);
}

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
): SkillSessionLoadResult {
  // 确保会话状态存在（通过 LRU helper 管理）
  if (!loadedSkillsMap.has(sessionId)) {
    setLoadedSkillsForSession(sessionId, new Map());
  }
  const sessionSkills = loadedSkillsMap.get(sessionId)!;

  const loaded: LoadedSkillInfo[] = [];
  const alreadyLoaded: string[] = [];
  const notFound: string[] = [];
  const rejectedById = new Map<string, SkillLoadRejection>();
  let removedRejectedSkill = false;

  // 收集所有需要加载的 skills（包括依赖）
  const toLoad: string[] = [];
  const visited = new Set<string>();

  // 递归收集依赖（含循环依赖检测）
  function collectDependencies(id: string, path: string[] = []): boolean {
    // 检测循环依赖
    if (path.includes(id)) {
      console.warn(LOG_PREFIX, `Circular dependency detected: ${path.join(' → ')} → ${id}`);
      rejectedById.set(id, {
        skillId: id,
        code: 'dependency_unavailable',
        message: `Skill "${id}" cannot be loaded because its dependency graph is circular`,
      });
      return false;
    }

    if (visited.has(id)) return !rejectedById.has(id);
    visited.add(id);

    const skill = skillRegistry.get(id);
    if (!skill) {
      console.warn(LOG_PREFIX, `Skill not found: ${id}`);
      if (!notFound.includes(id)) notFound.push(id);
      return false;
    }

    const admission = getSkillRuntimeAdmission(skill);
    if (!admission.allowed) {
      rejectedById.set(id, {
        skillId: id,
        code: admission.code!,
        message: admission.message!,
      });
      if (sessionSkills.delete(id)) {
        removedRejectedSkill = true;
      }
      return false;
    }

    // 先加载依赖，传递当前路径
    let dependenciesAvailable = true;
    if (skill.dependencies && skill.dependencies.length > 0) {
      for (const depId of skill.dependencies) {
        if (!collectDependencies(depId, [...path, id])) {
          dependenciesAvailable = false;
        }
      }
    }

    if (!dependenciesAvailable) {
      rejectedById.set(id, {
        skillId: id,
        code: 'dependency_unavailable',
        message: `Skill "${id}" cannot be loaded because one or more dependencies are unavailable`,
      });
      return false;
    }

    // 再加载自身
    toLoad.push(id);
    return true;
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
  if (loaded.length > 0 || removedRejectedSkill) {
    notifyListeners(sessionId);
  }
  if (loaded.length > 0) {
    // 使用遥测：记录工具加载（仅统计显式请求的技能，依赖不计）
    void import('./skillUsageStats')
      .then(({ recordSkillToolLoad }) => {
        for (const info of loaded) {
          if (skillIds.includes(info.id)) {
            recordSkillToolLoad(info.id);
          }
        }
      })
      .catch(() => { /* telemetry optional */ });
  }

  return { loaded, alreadyLoaded, notFound, rejected: Array.from(rejectedById.values()) };
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
    return { loaded: [], alreadyLoaded: [], notFound: [], rejected: [] };
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
    return JSON.stringify({
      result: {
        status: 'error',
        loaded_skill_ids: [],
        loaded_tool_names: [],
        loaded_tools: [],
        skill_state_version: 0,
        message: '请指定要加载的技能 ID 列表',
      },
    });
  }

  const { loaded, alreadyLoaded, notFound, rejected } = loadSkillsToSession(sessionId, skillIds);
  const sessionLoadedSkills = getLoadedSkills(sessionId);
  const loadedSkillIds = sessionLoadedSkills.map(skill => skill.id);
  const loadedTools = Array.from(new Map(
    sessionLoadedSkills
      .flatMap(skill =>
        skill.tools
          .filter(tool => tool.name)
          .map(tool => ({ name: tool.name, skill_id: skill.id }))
      )
      .map(tool => [`${tool.skill_id}\u0000${tool.name}`, tool]),
  ).values());
  const loadedToolNames = Array.from(new Set(
    loadedTools.map(tool => tool.name)
  ));

  const messageParts: string[] = [];
  if (loaded.length > 0) {
    messageParts.push('Skills loaded. Instructions will be provided in the next transient skill message.');
  }
  if (alreadyLoaded.length > 0) {
    messageParts.push(`Already loaded: ${alreadyLoaded.join(', ')}`);
  }
  if (notFound.length > 0) {
    messageParts.push(`Missing: ${notFound.join(', ')}`);
  }
  if (rejected.length > 0) {
    messageParts.push(rejected.map((item) => item.message).join(' '));
  }
  if (messageParts.length === 0) {
    messageParts.push('No new skills were loaded.');
  }

  return JSON.stringify({
    result: {
      status: loaded.length === 0 && alreadyLoaded.length === 0 && rejected.length > 0
        ? 'error'
        : 'success',
      loaded_skill_ids: loadedSkillIds,
      loaded_tool_names: loadedToolNames,
      loaded_tools: loadedTools,
      rejected_skills: rejected,
      skill_state_version: 0,
      message: messageParts.join(' '),
    },
  });
}

// ============================================================================
// available_skills 元数据生成
// ============================================================================

/**
 * 格式化 requires 门控缺失说明（与 registry.generateMetadataPrompt 语义对齐）
 */
function formatRequiresMissingReason(skillId: string): string {
  const gate = getRequiresGate(skillId);
  const missing = [
    ...(gate?.missingBins ?? []).map((name) => `缺少命令 ${name}`),
    ...(gate?.missingEnv ?? []).map((name) => `缺少环境变量 ${name}`),
    ...(gate?.missingPythonPackages ?? []).map((name) => `缺少 Python 包 ${name}`),
  ].join('、');
  return missing || '依赖不满足';
}

/**
 * 生成 available_skills XML 元数据
 *
 * 用于注入到 System Prompt 中，告知 LLM 可用的技能列表。
 * 与 `skillRegistry.generateMetadataPrompt` 一致：
 * - `disableAutoInvoke` 技能不出现
 * - requires 未满足的技能标注为不可用（不要加载）
 *
 * 缓存前缀约束（ROUND-01-cache-prefix R1 / ROUND-02-synthesis P1-8）：
 * 目录在会话内必须恒定——不按已加载状态收缩。技能加载后目录缩水会让
 * system 前缀从第 0 字节变化，导致整段历史的 prompt cache 失效。
 * 已加载状态由 load_skills 的 tool result（loaded_skill_ids 等）和
 * 尾部瞬态技能消息表达，不从 system 目录中剔除。
 */
export function generateAvailableSkillsPrompt(): string {
  const skills = skillRegistry.getAll().filter(isSkillPromptVisible);

  // 过滤掉 disableAutoInvoke 的 Skills
  const filteredSkills = skills.filter(s => !s.disableAutoInvoke);

  // 允许无 embeddedTools 的模式型 Skills（如 research-mode），工具数量为 0

  // 加载期 requires 门控：与 registry.generateMetadataPrompt 保持同一语义
  const availableSkills = filteredSkills.filter((skill) =>
    isSkillRequiresSatisfied(skill.id)
  );
  const gatedSkills = filteredSkills.filter(
    (skill) => !isSkillRequiresSatisfied(skill.id)
  );

  if (availableSkills.length === 0 && gatedSkills.length === 0) {
    return '';
  }

  const lines: string[] = ['<available_skills>'];

  for (const skill of availableSkills) {
    const toolCount = skill.embeddedTools?.length ?? 0;
    lines.push(`  <skill id="${escapeXmlAttr(skill.id)}" tools="${toolCount}">`);
    lines.push(`    ${escapeXmlText(skill.description)}`);
    lines.push(`  </skill>`);
  }

  if (gatedSkills.length > 0) {
    lines.push('');
    lines.push('  <!-- 以下技能因本机缺少运行依赖暂不可用（不要加载） -->');
    for (const skill of gatedSkills) {
      const toolCount = skill.embeddedTools?.length ?? 0;
      const reason = formatRequiresMissingReason(skill.id);
      lines.push(
        `  <skill id="${escapeXmlAttr(skill.id)}" tools="${toolCount}" available="false" reason="${escapeXmlAttr(reason)}">`
      );
      lines.push(`    ${escapeXmlText(skill.description)}`);
      lines.push(`  </skill>`);
    }
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
// available_skills 会话快照（P0 prompt cache）
// ============================================================================

/**
 * session_id → 首次生成的 available_skills 目录快照。
 *
 * 缓存前缀约束（P0，与 excludeLoaded 修复同一哲学）：目录直接拼进 system，
 * 而 system 是整段请求的第 0 字节前缀。会话中途 skill_install 改写 live
 * registry 后若继续读 live 目录，下一轮 system 就从目录处变字节，整段
 * 历史 prompt cache 失效。因此每个 session 首次生成后冻结快照，中途安装
 * 的技能不进入已发出的 system 目录 —— 新技能由 load_skills 的 tool result
 * 与瞬态技能消息表达。空目录同样冻结（安装前发过消息的会话保持无目录）。
 *
 * 模块级 Map：TauriAdapter 重建（切换会话再回来）不丢快照。这里是热路径
 * 读缓存，真身持久化在 session.metadata（`availableSkillsSnapshot`，见
 * AVAILABLE_SKILLS_SNAPSHOT_METADATA_KEY）：应用重启后 provider 侧 prompt
 * cache 仍可能存活，session 加载时用 hydrateSessionAvailableSkillsSnapshot
 * 从 metadata 回灌同一字节，禁止按当时 live registry 重算（重启前中途装过
 * 技能会让 system 从第 0 字节变）。从未冻结过的新 session 才按 live 建立。
 */
const sessionAvailableSkillsSnapshots = new Map<string, string>();

/**
 * session.metadata 中持久化目录快照的键名（与后端
 * `AVAILABLE_SKILLS_SNAPSHOT_METADATA_KEY` 常量对应）。
 */
export const AVAILABLE_SKILLS_SNAPSHOT_METADATA_KEY = 'availableSkillsSnapshot';

/**
 * 按 sessionId 返回冻结的 available_skills 目录。
 * 首次调用生成并快照；后续调用（包括 skill_install 之后）逐字节复用。
 */
export function getSessionAvailableSkillsPrompt(sessionId: string): string {
  const cached = sessionAvailableSkillsSnapshots.get(sessionId);
  if (cached !== undefined) {
    return cached;
  }
  const catalog = generateAvailableSkillsPrompt();
  sessionAvailableSkillsSnapshots.set(sessionId, catalog);
  return catalog;
}

/**
 * 会话是否已有内存目录快照（用于判断本次 getSessionAvailableSkillsPrompt
 * 是否为首次生成，首次生成后调用方负责持久化到 session.metadata）。
 */
export function hasSessionAvailableSkillsSnapshot(sessionId: string): boolean {
  return sessionAvailableSkillsSnapshots.has(sessionId);
}

/**
 * 用 session.metadata 中持久化的目录快照回灌内存（session 加载路径调用）。
 *
 * 持久化值是该会话首次生成后冻结的字节权威：应用重启后（内存 Map 清空）
 * 必须先 hydrate 再构建 system，禁止按当时 live registry 重算；多窗口竞争
 * 时后端 first-write-wins 返回的生效值也走这里回灌，保证内存与持久化一致。
 * 空串是合法快照（安装前发过消息的会话冻结为无目录）。
 */
export function hydrateSessionAvailableSkillsSnapshot(
  sessionId: string,
  snapshot: string
): void {
  sessionAvailableSkillsSnapshots.set(sessionId, snapshot);
}

/**
 * 清除会话目录快照（测试与会话删除用）。
 */
export function clearSessionAvailableSkillsSnapshot(sessionId: string): void {
  sessionAvailableSkillsSnapshots.delete(sessionId);
}

// ============================================================================
// available_skills_delta（目录增量，当前 user 尾部瞬态通道）
// ============================================================================
//
// R4 #7 定稿（见 docs/dev/wave2-A/r4-catalog-delta.md）：冻结目录解决了
// 「system 前缀字节不变」，代价是会话中途安装的技能对模型完全不可见
// （load_skills 报 not found 也无从谈起——模型根本不知道它存在）。
// delta 通道补齐可发现性，且零缓存成本：
//
// - 注入位置：仅当前请求最后一条 user 消息尾部（与瞬态技能消息同位），
//   属于每轮必然的新字节区，不落任何 provider prompt cache 前缀；
// - 生命周期：请求构建时即时渲染，**不持久化进消息历史**——下一轮该
//   user 消息进入历史时不携带 delta，历史字节由此保持稳定；
// - 基线语义：以本会话冻结快照字符串为唯一基线（解析持久化权威字节，
//   跨重启天然一致），live registry 中新增可加载而基线未以可用状态列出
//   的技能构成 delta。**只读快照，绝不触发冻结或覆盖**，first-write-wins
//   语义零影响；
// - 显式刷新代际（#6 compaction 换代）落地后基线换新目录，delta 自然
//   收缩为空，两通道无缝衔接。

/** delta 中单个新增技能条目（与冻结目录 <skill> 行同形） */
export interface AvailableSkillsDeltaEntry {
  /** Skill ID */
  id: string;
  /** 模型可见描述 */
  description: string;
  /** 该技能提供的工具数量 */
  toolCount: number;
}

/** 相对冻结目录基线的可用技能增量 */
export interface AvailableSkillsDelta {
  /** 基线快照中以可用状态列出的技能 ID（available="false" 门控条目不算） */
  baseSkillIds: string[];
  /** 基线之外新增可加载的技能（含基线中门控、现已满足 requires 的技能） */
  added: AvailableSkillsDeltaEntry[];
}

/**
 * 反转义 XML 属性值（escapeXmlAttr 的逆操作，用于解析冻结快照）。
 * &amp; 必须最后替换，避免二次解码。
 */
function unescapeXmlAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * 从冻结目录快照字符串中提取「以可用状态列出」的技能 ID 集合。
 *
 * 以持久化权威字节为解析源（而非另存一份 ID 列表），重启回灌后基线
 * 自动一致，无需第二个持久化键。available="false"（requires 门控）
 * 条目不计入基线——门控技能后续满足 requires 时应重新出现在 delta 中。
 * 空串快照（安装前发过消息的会话）解析为空基线，同样是合法输入。
 */
export function extractCatalogSkillIds(snapshot: string): Set<string> {
  const ids = new Set<string>();
  for (const match of snapshot.matchAll(/<skill\s+([^>]*?)\/?>/g)) {
    const attrs = match[1];
    if (/\bavailable="false"/.test(attrs)) continue;
    const idMatch = attrs.match(/\bid="([^"]*)"/);
    if (idMatch && idMatch[1]) {
      ids.add(unescapeXmlAttr(idMatch[1]));
    }
  }
  return ids;
}

/**
 * 计算会话相对冻结目录基线的可用技能增量。
 *
 * 只读 sessionAvailableSkillsSnapshots，**绝不调用
 * getSessionAvailableSkillsPrompt**（那会产生冻结副作用）。会话尚未
 * 冻结快照时返回 null：此时首轮 system 目录尚未定基线，本轮目录本身
 * 就是 live 全量，delta 无语义。
 *
 * added 的过滤口径与 generateAvailableSkillsPrompt 的可用段一致
 * （prompt 可见 + 非 disableAutoInvoke + requires 满足），顺序沿用
 * registry 顺序，保证同一轮内渲染确定。
 */
export function computeAvailableSkillsDelta(sessionId: string): AvailableSkillsDelta | null {
  const snapshot = sessionAvailableSkillsSnapshots.get(sessionId);
  if (snapshot === undefined) {
    return null;
  }

  const baseSkillIds = extractCatalogSkillIds(snapshot);
  const added = skillRegistry
    .getAll()
    .filter(isSkillPromptVisible)
    .filter((skill) => !skill.disableAutoInvoke)
    .filter((skill) => isSkillRequiresSatisfied(skill.id))
    .filter((skill) => !baseSkillIds.has(skill.id))
    .map((skill) => ({
      id: skill.id,
      description: skill.description,
      toolCount: skill.embeddedTools?.length ?? 0,
    }));

  return { baseSkillIds: Array.from(baseSkillIds), added };
}

/**
 * 渲染 available_skills_delta 尾部瞬态块。
 *
 * 调用方约束（接线属 #5/后续轮，本轮不动 TauriAdapter）：
 * - 只允许拼接在当前请求最后一条 user 消息尾部（瞬态技能消息同位）；
 * - 禁止写入 system、禁止持久化进消息历史；
 * - 每轮请求构建时重算——技能继续安装则 delta 增长，显式换代刷新
 *   （#6）后基线换新，delta 自然清空。
 *
 * 无冻结基线或无增量时返回空串（调用方零拼接）。
 */
export function generateAvailableSkillsDeltaPrompt(sessionId: string): string {
  const delta = computeAvailableSkillsDelta(sessionId);
  if (!delta || delta.added.length === 0) {
    return '';
  }

  const lines: string[] = ['<available_skills_delta>'];
  for (const entry of delta.added) {
    lines.push(`  <skill id="${escapeXmlAttr(entry.id)}" tools="${entry.toolCount}">`);
    lines.push(`    ${escapeXmlText(entry.description)}`);
    lines.push(`  </skill>`);
  }
  lines.push('</available_skills_delta>');
  lines.push('');
  lines.push(
    '以上是本会话开始后新增可用的技能（未列入 <available_skills>）。如需使用，同样通过 load_skills 工具加载。'
  );
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
  autoLoadSkills: [],
  preloadAllTools: false,
};

const currentConfig: ProgressiveDisclosureConfig = { ...DEFAULT_PROGRESSIVE_DISCLOSURE_CONFIG };

/**
 * 获取当前配置
 */
export function getProgressiveDisclosureConfig(): ProgressiveDisclosureConfig {
  return { ...currentConfig };
}
