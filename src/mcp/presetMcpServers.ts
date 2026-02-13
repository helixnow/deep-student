/**
 * 预置 MCP 服务器配置
 * 
 * 这些是网络类型（SSE/HTTP）的 MCP 服务器，跨平台兼容性好
 * 不需要本地安装 Node.js 等依赖
 * 
 * @see https://context7.com - 文档检索 MCP
 */

export interface PresetMcpServer {
  /** 唯一标识符 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 描述（i18n 键） */
  descriptionKey: string;
  /** 传输类型 - 仅网络类型 */
  transportType: 'sse' | 'streamable_http';
  /** 服务器 URL */
  url: string;
  /** 是否需要 API Key */
  requiresApiKey: boolean;
  /** API Key 说明（如果需要） */
  apiKeyHint?: string;
  /** 分类标签 */
  category: 'documentation';
  /** 来源平台 */
  source: 'community';
  /** 主页链接 */
  homepage?: string;
  /** 是否可编辑（预置服务器默认可编辑） */
  editable?: boolean;
}

/**
 * 预置 MCP 服务器列表
 * 
 * 仅包含网络类型（SSE/HTTP）的服务器，确保跨平台兼容性
 * 优先级排序：
 * 1. 免费且无需 API Key 的放前面
 * 2. 稳定可靠的托管服务优先
 */
export const PRESET_MCP_SERVERS: PresetMcpServer[] = [
  // ============================================================================
  // 文档类 - 免费无需 API Key，国内可访问
  // ============================================================================
  {
    id: 'context7',
    name: 'Context7',
    descriptionKey: 'settings:mcp_presets.context7_desc',
    transportType: 'streamable_http',
    url: 'https://mcp.context7.com/mcp',
    requiresApiKey: false,
    category: 'documentation',
    source: 'community',
    homepage: 'https://context7.com',
    editable: true,
  },
];

/**
 * 获取免费（无需 API Key）的预置服务器
 */
export function getFreeMcpServers(): PresetMcpServer[] {
  return PRESET_MCP_SERVERS.filter(s => !s.requiresApiKey);
}

/**
 * 将预置服务器转换为可保存的配置格式
 */
export function presetToMcpConfig(preset: PresetMcpServer, options?: {
  apiKey?: string;
}): {
  id: string;
  name: string;
  transportType: 'sse' | 'streamable_http';
  url: string;
  namespace?: string;
  apiKey?: string;
} {
  const config: {
    id: string;
    name: string;
    transportType: 'sse' | 'streamable_http';
    url: string;
    namespace: string;
    apiKey?: string;
  } = {
    id: `preset_${preset.id}_${Date.now()}`,
    name: preset.name,
    transportType: preset.transportType,
    url: preset.url,
    namespace: `${preset.id}:`,
  };

  // 如果需要 API Key 且提供了，添加到配置
  if (preset.requiresApiKey && options?.apiKey) {
    config.apiKey = options.apiKey;
  }

  return config;
}

/**
 * 分类名称映射（i18n 键）
 */
export const CATEGORY_LABELS: Record<string, string> = {
  'documentation': 'settings:mcp_presets.category_documentation',
};
