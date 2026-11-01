// Types
export interface McpServer {
  id: string;
  name: string;
  /** 与 secure store mcp.tools.list 的 enabled 字段共享同一状态（缺省视为启用）；agent 的 mcp_server_set_enabled 也写同一字段 */
  enabled?: boolean;
  transportType?: 'stdio' | 'websocket' | 'sse' | 'streamable_http' | 'builtin';
  url?: string;
  command?: string;
  args?: string | string[];
  namespace?: string;
  env?: Record<string, string>;
  apiKey?: string;
}

export interface McpServerStatus {
  connected: boolean;
  error?: string;
}

export interface McpCachedTool {
  name: string;
  description?: string;
}

// 展开面板类型
export type ExpandedPanelType = 'preview' | 'edit' | null;
