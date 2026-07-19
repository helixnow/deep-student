/**
 * 预置 MCP 服务器配置
 *
 * 仅收录已核实的远程（SSE / Streamable HTTP）MCP，跨平台无需本地 Node。
 * 每项附带 permissions / risk，安装前由 UI 展示权限 Drawer。
 */

/** 权限与风险元数据（安装前展示） */
export interface PresetMcpPermissions {
  /** 数据范围说明（i18n 键） */
  dataScopeKey: string;
  /** 是否会出网访问外部资源 */
  networkEgress: boolean;
  /** API Key / Token 获取链接（如需） */
  apiKeyUrl?: string;
  /** 额外说明（i18n 键） */
  notesKey?: string;
}

export type PresetMcpRisk = 'low' | 'medium' | 'high';

/** 认证方式标注 */
export type PresetAuthKind =
  | 'none'
  | 'api_key'
  | 'oauth_ready' // 支持或即将支持 OAuth 桌面流
  | 'api_key_or_oauth';

export type PresetMcpCategory =
  | 'documentation'
  | 'search'
  | 'knowledge'
  | 'scraping'
  | 'devops';

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
  /** 是否需要 API Key（安装时强制输入） */
  requiresApiKey: boolean;
  /** API Key 说明（如果需要） */
  apiKeyHint?: string;
  /** 认证方式 */
  authKind: PresetAuthKind;
  /** 权限说明 */
  permissions: PresetMcpPermissions;
  /** 风险等级 */
  risk: PresetMcpRisk;
  /** 分类标签 */
  category: PresetMcpCategory;
  /** 来源平台 */
  source: 'official' | 'community';
  /** 主页链接 */
  homepage?: string;
  /** 核实出处（文档 / changelog URL） */
  verifiedSource: string;
  /** 是否可编辑（预置服务器默认可编辑） */
  editable?: boolean;
}

/**
 * 预置 MCP 服务器列表（2026-07 核实）
 *
 * 排序：免费 / 无需 Key → 可选 Key → 必需凭据 / OAuth
 * 无法核实官方 remote endpoint 的不上架（如 Brave 仅有本地/自托管）。
 */
export const PRESET_MCP_SERVERS: PresetMcpServer[] = [
  // ============================================================================
  // 免费 / 无需 API Key
  // ============================================================================
  {
    id: 'context7',
    name: 'Context7',
    descriptionKey: 'settings:mcp_presets.context7_desc',
    transportType: 'streamable_http',
    url: 'https://mcp.context7.com/mcp',
    requiresApiKey: false,
    authKind: 'none',
    permissions: {
      dataScopeKey: 'settings:mcp_presets.permissions.context7_scope',
      networkEgress: true,
      notesKey: 'settings:mcp_presets.permissions.context7_notes',
    },
    risk: 'low',
    category: 'documentation',
    source: 'community',
    homepage: 'https://context7.com',
    verifiedSource: 'https://context7.com',
    editable: true,
  },
  {
    id: 'exa',
    name: 'Exa Search',
    descriptionKey: 'settings:mcp_presets.exa_desc',
    transportType: 'streamable_http',
    url: 'https://mcp.exa.ai/mcp',
    requiresApiKey: false,
    authKind: 'api_key',
    apiKeyHint: 'settings:mcp_presets.hints.exa_key',
    permissions: {
      dataScopeKey: 'settings:mcp_presets.permissions.exa_scope',
      networkEgress: true,
      apiKeyUrl: 'https://dashboard.exa.ai/api-keys',
      notesKey: 'settings:mcp_presets.permissions.exa_notes',
    },
    risk: 'low',
    category: 'search',
    source: 'official',
    homepage: 'https://exa.ai/mcp',
    verifiedSource: 'https://exa.ai/docs/reference/exa-mcp',
    editable: true,
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    descriptionKey: 'settings:mcp_presets.wikipedia_desc',
    transportType: 'streamable_http',
    url: 'https://gateway.pipeworx.io/wikipedia/mcp',
    requiresApiKey: false,
    authKind: 'none',
    permissions: {
      dataScopeKey: 'settings:mcp_presets.permissions.wikipedia_scope',
      networkEgress: true,
      notesKey: 'settings:mcp_presets.permissions.wikipedia_notes',
    },
    risk: 'low',
    category: 'knowledge',
    source: 'community',
    homepage: 'https://pipeworx.io/',
    verifiedSource: 'https://mcp-marketplace.io/server/io-github-pipeworx-io-wikipedia',
    editable: true,
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    descriptionKey: 'settings:mcp_presets.firecrawl_desc',
    transportType: 'streamable_http',
    url: 'https://mcp.firecrawl.dev/v2/mcp',
    requiresApiKey: false,
    authKind: 'api_key_or_oauth',
    apiKeyHint: 'settings:mcp_presets.hints.firecrawl_key',
    permissions: {
      dataScopeKey: 'settings:mcp_presets.permissions.firecrawl_scope',
      networkEgress: true,
      apiKeyUrl: 'https://www.firecrawl.dev/app/api-keys',
      notesKey: 'settings:mcp_presets.permissions.firecrawl_notes',
    },
    risk: 'medium',
    category: 'scraping',
    source: 'official',
    homepage: 'https://docs.firecrawl.dev/mcp-server',
    verifiedSource: 'https://docs.firecrawl.dev/mcp-server',
    editable: true,
  },
  {
    id: 'cloudflare_docs',
    name: 'Cloudflare Docs',
    descriptionKey: 'settings:mcp_presets.cloudflare_docs_desc',
    transportType: 'streamable_http',
    url: 'https://docs.mcp.cloudflare.com/mcp',
    requiresApiKey: false,
    authKind: 'oauth_ready',
    permissions: {
      dataScopeKey: 'settings:mcp_presets.permissions.cloudflare_docs_scope',
      networkEgress: true,
      notesKey: 'settings:mcp_presets.permissions.cloudflare_docs_notes',
    },
    risk: 'low',
    category: 'documentation',
    source: 'official',
    homepage: 'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/',
    verifiedSource: 'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/',
    editable: true,
  },
  // ============================================================================
  // 需要 Key / OAuth
  // ============================================================================
  {
    id: 'tavily',
    name: 'Tavily',
    descriptionKey: 'settings:mcp_presets.tavily_desc',
    transportType: 'streamable_http',
    url: 'https://mcp.tavily.com/mcp/',
    requiresApiKey: false,
    authKind: 'api_key_or_oauth',
    apiKeyHint: 'settings:mcp_presets.hints.tavily_key',
    permissions: {
      dataScopeKey: 'settings:mcp_presets.permissions.tavily_scope',
      networkEgress: true,
      apiKeyUrl: 'https://www.tavily.com/',
      notesKey: 'settings:mcp_presets.permissions.tavily_notes',
    },
    risk: 'low',
    category: 'search',
    source: 'official',
    homepage: 'https://github.com/tavily-ai/tavily-mcp',
    verifiedSource: 'https://github.com/tavily-ai/tavily-mcp',
    editable: true,
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    descriptionKey: 'settings:mcp_presets.huggingface_desc',
    transportType: 'streamable_http',
    url: 'https://huggingface.co/mcp',
    requiresApiKey: false,
    authKind: 'api_key_or_oauth',
    apiKeyHint: 'settings:mcp_presets.hints.huggingface_token',
    permissions: {
      dataScopeKey: 'settings:mcp_presets.permissions.huggingface_scope',
      networkEgress: true,
      apiKeyUrl: 'https://huggingface.co/settings/tokens',
      notesKey: 'settings:mcp_presets.permissions.huggingface_notes',
    },
    risk: 'medium',
    category: 'knowledge',
    source: 'official',
    homepage: 'https://huggingface.co/mcp',
    verifiedSource: 'https://huggingface.co/docs/hub/main/agents-mcp',
    editable: true,
  },
  {
    id: 'github',
    name: 'GitHub',
    descriptionKey: 'settings:mcp_presets.github_desc',
    transportType: 'streamable_http',
    url: 'https://api.githubcopilot.com/mcp/',
    requiresApiKey: true,
    authKind: 'api_key_or_oauth',
    apiKeyHint: 'settings:mcp_presets.hints.github_pat',
    permissions: {
      dataScopeKey: 'settings:mcp_presets.permissions.github_scope',
      networkEgress: true,
      apiKeyUrl: 'https://github.com/settings/tokens',
      notesKey: 'settings:mcp_presets.permissions.github_notes',
    },
    risk: 'high',
    category: 'devops',
    source: 'official',
    homepage: 'https://github.com/github/github-mcp-server',
    verifiedSource: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md',
    editable: true,
  },
];

/**
 * 获取免费（无需强制 API Key）的预置服务器
 */
export function getFreeMcpServers(): PresetMcpServer[] {
  return PRESET_MCP_SERVERS.filter((s) => !s.requiresApiKey);
}

/**
 * 是否标注为可走 OAuth（含将来可 OAuth）
 */
export function isOAuthCapablePreset(preset: PresetMcpServer): boolean {
  return preset.authKind === 'oauth_ready' || preset.authKind === 'api_key_or_oauth';
}

/**
 * 将预置服务器转换为可保存的配置格式
 */
export function presetToMcpConfig(
  preset: PresetMcpServer,
  options?: {
    apiKey?: string;
    /** 启用 OAuth 占位配置（与 apiKey 互斥；apiKey 优先） */
    enableOauth?: boolean;
  },
): {
  id: string;
  name: string;
  transportType: 'sse' | 'streamable_http';
  url: string;
  namespace?: string;
  apiKey?: string;
  oauth?: {
    client_id: string;
    auth_url: string;
    token_url: string;
    redirect_uri: string;
    scopes: string[];
  };
  presetId?: string;
  authKind?: PresetAuthKind;
  risk?: PresetMcpRisk;
} {
  const config: {
    id: string;
    name: string;
    transportType: 'sse' | 'streamable_http';
    url: string;
    namespace: string;
    apiKey?: string;
    oauth?: {
      client_id: string;
      auth_url: string;
      token_url: string;
      redirect_uri: string;
      scopes: string[];
    };
    presetId: string;
    authKind: PresetAuthKind;
    risk: PresetMcpRisk;
  } = {
    id: `preset_${preset.id}_${Date.now()}`,
    name: preset.name,
    transportType: preset.transportType,
    url: preset.url,
    namespace: `${preset.id}:`,
    presetId: preset.id,
    authKind: preset.authKind,
    risk: preset.risk,
  };

  // 互斥：显式 API Key 优先于 OAuth 占位
  if (options?.apiKey) {
    config.apiKey = options.apiKey;
  } else if (options?.enableOauth && isOAuthCapablePreset(preset)) {
    config.oauth = {
      client_id: '',
      auth_url: '',
      token_url: '',
      redirect_uri: 'http://127.0.0.1/auth/callback',
      scopes: [],
    };
  } else if (preset.requiresApiKey && options?.apiKey) {
    config.apiKey = options.apiKey;
  }

  return config;
}

/**
 * 分类名称映射（i18n 键）
 */
export const CATEGORY_LABELS: Record<PresetMcpCategory | string, string> = {
  documentation: 'settings:mcp_presets.category_documentation',
  search: 'settings:mcp_presets.category_search',
  knowledge: 'settings:mcp_presets.category_knowledge',
  scraping: 'settings:mcp_presets.category_scraping',
  devops: 'settings:mcp_presets.category_devops',
};

export const RISK_LABELS: Record<PresetMcpRisk, string> = {
  low: 'settings:mcp_presets.risk_low',
  medium: 'settings:mcp_presets.risk_medium',
  high: 'settings:mcp_presets.risk_high',
};
