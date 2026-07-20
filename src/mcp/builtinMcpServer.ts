/**
 * 内置 MCP 服务器定义
 *
 * 工具的 SSOT（单一事实来源）是 Skills 渐进披露系统：
 * `src/features/chat/skills/builtin-tools/`（knowledge-retrieval、
 * learning-resource、vfs-memory、index-webpage-tools 等），本模块通过
 * `builtinToolSkills` 动态派生工具 Schema，不再维护静态工具数组。
 *
 * 🔧 2026-07: 已删除废弃的静态 BUILTIN_TOOLS 数组——它与 Skills 定义
 * 持续漂移（包含已收敛进 unified_search 的 rag_search/multimodal_search、
 * 弱化多模态能力的旧描述等）。如需工具 Schema，请使用
 * `getBuiltinToolsWithDynamicSchema()` / `getBuiltinToolSchemas()`。
 *
 * 此文件保留以下内容供其他模块使用：
 * - BUILTIN_SERVER_ID, BUILTIN_NAMESPACE: 常量
 * - isBuiltinServer, isBuiltinTool, stripBuiltinNamespace: 辅助函数
 * - getToolDisplayNameKey: 工具 i18n 显示名称
 * - ALL_SEARCH_ENGINE_IDS: 搜索引擎类型
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import { builtinToolSkills } from '../features/chat/skills/builtin-tools';

// 内置服务器常量
export const BUILTIN_SERVER_ID = '__builtin__tools';
// 🔧 使用 'builtin-' 而非 'builtin:' 以兼容 DeepSeek/OpenAI API 的工具名称限制
// API 要求工具名称符合正则 ^[a-zA-Z0-9_-]+$，不允许冒号
export const BUILTIN_NAMESPACE = 'builtin-';
export const BUILTIN_SERVER_NAME = '内置工具';
export const BUILTIN_SERVER_NAME_EN = 'Built-in Tools';

/**
 * 内置工具 Schema 定义
 */
export interface BuiltinToolSchema {
  name: string;
  /** i18n 翻译键，用于获取可读的工具名称 */
  displayNameKey: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function buildBuiltinToolsFromSkills(): BuiltinToolSchema[] {
  const tools: BuiltinToolSchema[] = [];
  for (const skill of builtinToolSkills) {
    if (!skill.embeddedTools) {
      continue;
    }
    for (const tool of skill.embeddedTools) {
      const shortName = tool.name.startsWith(BUILTIN_NAMESPACE)
        ? tool.name.replace(BUILTIN_NAMESPACE, '')
        : tool.name.replace('mcp_', '');
      tools.push({
        name: tool.name,
        displayNameKey: `tools.${shortName}`,
        description: tool.description,
        inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
      });
    }
  }
  return tools;
}

function applyWebSearchEngines(
  tool: BuiltinToolSchema,
  availableSearchEngines?: string[]
): BuiltinToolSchema {
  if (stripBuiltinNamespace(tool.name) !== 'web_search') {
    return tool;
  }
  const validEngines = availableSearchEngines?.filter(
    (e): e is SearchEngineId => ALL_SEARCH_ENGINE_IDS.includes(e as SearchEngineId)
  );
  if (!validEngines || validEngines.length === 0) {
    return tool;
  }
  const inputSchema =
    tool.inputSchema && typeof tool.inputSchema === 'object'
      ? { ...(tool.inputSchema as Record<string, unknown>) }
      : { type: 'object', properties: {} };
  const properties = {
    ...((inputSchema.properties as Record<string, unknown>) ?? {}),
  };
  properties.engine = {
    type: 'string',
    enum: validEngines,
    description: `可用的搜索引擎：${validEngines.join(', ')}。如果不指定，使用默认配置的引擎。`,
  };
  inputSchema.properties = properties;
  return {
    ...tool,
    inputSchema,
  };
}

function getBuiltinToolsFromSkills(availableSearchEngines?: string[]): BuiltinToolSchema[] {
  const tools = buildBuiltinToolsFromSkills();
  if (!availableSearchEngines) {
    return tools;
  }
  return tools.map((tool) => applyWebSearchEngines(tool, availableSearchEngines));
}

/**
 * MCP 工具类型（与 DialogControlContext 中的类型对齐）
 */
export interface McpTool {
  id: string;
  name: string;
  description?: string;
  isOnline?: boolean;
  serverId?: string;
  serverName?: string;
}

/**
 * MCP 服务器类型（与 DialogControlContext 中的类型对齐）
 */
export interface McpServer {
  id: string;
  name: string;
  connected: boolean;
  toolsCount: number;
  tools: McpTool[];
}

/**
 * 获取内置服务器实例
 *
 * 🔧 2026-01-20: 从新的 Skills 系统获取工具定义，不再使用废弃的 BUILTIN_TOOLS 数组
 *
 * @param _availableSearchEngines 已废弃，保留参数签名以保持兼容
 */
export function getBuiltinServer(_availableSearchEngines?: string[]): McpServer {
  // 从新的 Skills 系统动态获取所有内置工具
  // 使用静态导入的 builtinToolSkills（无循环依赖）
  const skills = builtinToolSkills;

  const tools: McpTool[] = [];
  for (const skill of skills) {
    if (skill.embeddedTools) {
      for (const tool of skill.embeddedTools) {
        tools.push({
          id: tool.name,
          name: tool.name.replace(BUILTIN_NAMESPACE, ''),
          description: tool.description,
          isOnline: true, // 内置工具始终在线
          serverId: BUILTIN_SERVER_ID,
          serverName: BUILTIN_SERVER_NAME,
        });
      }
    }
  }

  return {
    id: BUILTIN_SERVER_ID,
    name: BUILTIN_SERVER_NAME,
    connected: true, // 内置服务器始终"已连接"
    toolsCount: tools.length,
    tools,
  };
}

/**
 * 检查是否为内置服务器
 */
export function isBuiltinServer(serverId: string): boolean {
  return serverId === BUILTIN_SERVER_ID;
}

/**
 * 检查工具名称是否为内置工具
 */
export function isBuiltinTool(toolName: string): boolean {
  return toolName.startsWith(BUILTIN_NAMESPACE);
}

/**
 * 从工具名称中去除内置命名空间前缀
 */
export function stripBuiltinNamespace(toolName: string): string {
  return toolName.replace(BUILTIN_NAMESPACE, '');
}

/**
 * 获取内置工具的 Schema 列表（用于传递给后端）
 * 
 * @param availableSearchEngines 可用的搜索引擎 ID 列表。传入后 web_search 工具的 engine 参数只会包含这些引擎。
 */
export function getBuiltinToolSchemas(availableSearchEngines?: string[]): Array<{
  name: string;
  description?: string;
  inputSchema?: unknown;
}> {
  const allTools = getBuiltinToolsWithDynamicSchema(availableSearchEngines);
  return allTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/**
 * 获取工具的 displayNameKey
 *
 * 🔧 2026-01-20: 动态生成 i18n 键，格式为 mcp.tools.{toolName}
 * 🔒 2026-07: `mcp_` / `mcp.tools.` 是外部 MCP 来源标记，不得命中内置词条；
 * 否则第三方同名工具会被误显示为内置工具。
 *
 * @param toolName 内置工具名称（如 builtin-web_search）
 * @returns i18n 翻译键，如果不是内置工具则返回 undefined
 */
export function getToolDisplayNameKey(toolName: string): string | undefined {
  if (toolName.startsWith(BUILTIN_NAMESPACE)) {
    const shortName = toolName.replace(BUILTIN_NAMESPACE, '');
    return `tools.${shortName}`;
  }
  return undefined;
}

/**
 * 检查工具是否有国际化显示名称
 */
export function hasToolDisplayName(toolName: string): boolean {
  return toolName.startsWith(BUILTIN_NAMESPACE);
}

// ============================================================================
// 动态 web_search 工具 Schema 生成
// ============================================================================

/**
 * 所有支持的搜索引擎 ID
 */
export const ALL_SEARCH_ENGINE_IDS = [
  'bing_rss',
  'google_cse',
  'serpapi',
  'tavily',
  'brave',
  'searxng',
  'zhipu',
  'bocha',
] as const;

export type SearchEngineId = typeof ALL_SEARCH_ENGINE_IDS[number];

/**
 * 动态生成 web_search 工具的 Schema
 * 
 * @param availableEngines 可用的搜索引擎 ID 列表。如果为空或未提供，则不包含 engine 参数（让后端自动选择）
 * @returns web_search 工具的完整 Schema
 */
export function getWebSearchToolSchema(availableEngines?: string[]): BuiltinToolSchema {
  const tools = getBuiltinToolsFromSkills(availableEngines);
  const webSearchTool = tools.find(
    (tool) => stripBuiltinNamespace(tool.name) === 'web_search'
  );
  if (webSearchTool) {
    return webSearchTool;
  }
  return {
    name: `${BUILTIN_NAMESPACE}web_search`,
    displayNameKey: 'tools.web_search',
    description: '搜索互联网获取最新信息。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索查询文本',
        },
      },
      required: ['query'],
    },
  };
}

/**
 * 获取完整的内置工具列表（包含动态生成的 web_search）
 * 
 * @param availableSearchEngines 可用的搜索引擎 ID 列表
 * @returns 完整的内置工具 Schema 列表
 */
export function getBuiltinToolsWithDynamicSchema(availableSearchEngines?: string[]): BuiltinToolSchema[] {
  return getBuiltinToolsFromSkills(availableSearchEngines);
}
