export interface McpTestResult {
  success: boolean;
  tools_count?: number;
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
}

export interface McpPreviewItem {
  name: string;
  description?: string;
}

export interface McpPreviewResource {
  uri: string;
  name?: string;
  description?: string;
  mime_type?: string;
}

export type McpToolModalState = {
  open: boolean;
  index: number | null; // null 表示新增
  mode: 'form' | 'json'; // 编辑模式
  jsonInput: string; // JSON输入内容
  draft: { 
    id: string; 
    name: string; 
    transportType: 'stdio'|'websocket'|'sse'|'streamable_http'; 
    // SSE/Streamable HTTP 配置
    fetch?: {
      type: 'sse'|'streamable_http';
      url: string;
    };
    // WebSocket 配置
    url?: string; 
    // Stdio 配置
    command?: string; 
    args?: string[] | string; 
    // 环境变量
    env?: Record<string, string>; 
    // HTTP 请求头
    headers?: Record<string, string>;
    // 旧版兼容字段
    endpoint?: string; 
    apiKey?: string;
    oauth?: {
      client_id: string;
      auth_url: string;
      token_url: string;
      redirect_uri: string;
      scopes: string[];
    };
    serverId?: string; 
    region?: string; 
    hosted?: boolean; 
    cwd?: string; 
    framing?: 'jsonl' | 'content_length'; 
    // 新增字段支持
    mcpServers?: Record<string, unknown>;
    namespace?: string;
  };
  error?: string | null;
};

export type McpPolicyModalState = { open: boolean; advertiseAll: boolean; whitelist: string; blacklist: string; timeoutMs: number; rateLimit: number; cacheMax: number; cacheTtlMs: number };

export type McpPreviewState = { open: boolean; loading: boolean; serverId?: string; serverName?: string; error?: string; tools: McpPreviewItem[]; prompts: McpPreviewItem[]; resources: McpPreviewResource[] };

export type McpCachedDetailsState = {
  toolsByServer: Record<string, { items: Array<{ name: string; description?: string }>; at?: number }>;
  prompts: { items: Array<{ name: string; description?: string }>; at?: number };
  resources: { items: Array<{ uri: string; name?: string; description?: string; mime_type?: string }>; at?: number };
};
