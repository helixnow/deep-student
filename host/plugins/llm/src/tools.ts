/**
 * 工具广告（llm_manager/mod.rs build_tools_with_mcp）。
 *
 * 无窗口 runtime 没有前端 MCP 桥：MCP 发现整体跳过（空集合），本地工具
 * （如 web_search）不受影响。
 */
import type { JsonValue } from '../../../platform/errors/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';

export interface FrontendMcpTool {
  name: string;
  description?: string | null;
  input_schema: JsonValue;
}

export interface PreparedMcpTool {
  schema: JsonValue;
}

export interface BuildToolsOptions {
  /** `session.selected_search_engines` 原字符串。 */
  selectedSearchEngines?: string | null;
  /** 前端窗口句柄；null 表示无窗口 runtime。 */
  window?: unknown | null;
  /** 已发现的前端 MCP 工具（无窗口时应为空，不进行发现）。 */
  mcpTools?: FrontendMcpTool[];
  mcp?: {
    advertiseAll?: boolean;
    whitelist?: string[];
    blacklist?: string[];
    selected?: string[];
    namespacePrefix?: string;
    prepare?: (tool: FrontendMcpTool, apiNamePrefix: string | null) => PreparedMcpTool | null;
  };
}

/** OpenAI function tool schema（与 Rust build_openai_function_tool_schema 一致）。 */
export function buildOpenAiFunctionToolSchema(
  name: string,
  description: string | null,
  parameters: JsonValue,
): JsonValue {
  return {
    type: 'function',
    function: {
      name,
      ...(description === null ? {} : { description }),
      parameters: parameters ?? { type: 'object', properties: {} },
    },
  };
}

function splitList(value: string | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  return value.split(',').map(rustTrim).filter((item) => item !== '');
}

function webSearchTool(selectedEngines: string[]): JsonValue {
  const properties: { [key: string]: JsonValue } = {
    query: { type: 'string', description: 'The web search query' },
    top_k: {
      type: 'integer', description: 'Max results to return', default: 5,
    },
    site: {
      type: 'string', description: 'Optional site restriction (e.g., example.com)',
    },
    time_range: {
      type: 'string', description: 'Optional time range: 1d|7d|30d',
    },
  };
  if (selectedEngines.length > 1) {
    properties.engine = {
      type: 'string',
      enum: selectedEngines,
      description: `Search engine to use. Available: ${selectedEngines.join(', ')}`,
    };
  }
  return buildOpenAiFunctionToolSchema(
    'web_search',
    'Search the INTERNET/WEB for current information, news, people, events, '
      + 'or any information not available in local knowledge base. Use this when users '
      + 'explicitly ask for web search or for real-time/current information.',
    { type: 'object', properties, required: ['query'] },
  );
}

/** 构建最终工具数组；无窗口时绝不触发 MCP 发现。 */
export function buildToolsWithMcp(options: BuildToolsOptions = {}): JsonValue[] {
  const tools: JsonValue[] = [];
  const selectedEngines = splitList(options.selectedSearchEngines);
  if (rustTrim(options.selectedSearchEngines ?? '') !== '') tools.push(webSearchTool(selectedEngines));

  if (options.window === null || options.window === undefined) return tools;

  const mcp = options.mcp ?? {};
  const whitelist = mcp.whitelist ?? [];
  const blacklist = mcp.blacklist ?? [];
  const selected = mcp.selected ?? [];
  const namespacePrefix = rustTrim(mcp.namespacePrefix ?? '');
  const apiNamePrefix = namespacePrefix === '' ? null : namespacePrefix;
  for (const tool of options.mcpTools ?? []) {
    const name = rustTrim(tool.name);
    if (name === '') continue;
    let allowed = selected.length > 0
      ? selected.includes(name)
      : mcp.advertiseAll === true
        ? true
        : whitelist.includes(name);
    if (blacklist.includes(name)) allowed = false;
    if (!allowed) continue;
    if (mcp.prepare === undefined) continue;
    const prepared = mcp.prepare(tool, apiNamePrefix);
    if (prepared === null) continue;
    tools.push(prepared.schema);
  }
  return tools;
}
