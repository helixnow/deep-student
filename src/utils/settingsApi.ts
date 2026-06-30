import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './shared';

export async function saveSetting(key: string, value: string): Promise<void> {
  try {
    if (!isTauriRuntime) {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, value);
      }
      return;
    }
    await invoke<void>('save_setting', { key, value });
  } catch (error) {
    console.error('Failed to save setting:', error);
    throw new Error(`Failed to save setting: ${error}`);
  }
}

export async function getSetting(key: string): Promise<string | null> {
  try {
    if (!isTauriRuntime) {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    }
    const response = await invoke<string | null>('get_setting', { key });
    return response;
  } catch (error) {
    console.error('Failed to get setting:', error);
    // 仅在 Tauri 运行时不可用时回退到 localStorage
    const fallback = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    return fallback;
  }
}

export async function deleteSetting(key: string): Promise<void> {
  try {
    if (!isTauriRuntime) {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(key);
      }
      return;
    }
    await invoke<boolean>('delete_setting', { key });
  } catch (error) {
    console.error('Failed to delete setting:', error);
    // 仅在 Tauri 运行时不可用时回退到 localStorage
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(key);
    }
  }
}

// MCP helpers
export async function testMcpConnection(command: string, args: string[], env?: Record<string, string>, options?: { cwd?: string | null; framing?: 'jsonl' | 'content_length' | null }): Promise<any> {
  try {
    const response = await invoke<any>('test_mcp_connection', {
      command,
      args,
      env,
      cwd: options?.cwd ?? null,
      framing: options?.framing ?? null,
    });
    return response;
  } catch (error) {
    console.error('Failed to test MCP connection:', error);
    throw new Error(`Failed to test MCP connection: ${error}`);
  }
}

// Deep Research APIs removed

// Utilities
export async function saveTextToFile(path: string, content: string): Promise<void> {
  await invoke('save_text_to_file', { path, content });
}

export async function readFileText(path: string): Promise<string> {
  return await invoke<string>('read_file_text', { path });
}

export async function testMcpWebsocket(url: string, env?: Record<string, string>): Promise<any> {
  try {
    const response = await invoke<any>('test_mcp_websocket', { url, env });
    return response;
  } catch (error) {
    console.error('Failed to test MCP WebSocket connection:', error);
    throw new Error(`Failed to test MCP WebSocket connection: ${error}`);
  }
}

export async function testMcpSse(endpoint: string, apiKey: string, env?: Record<string, string>): Promise<any> {
  try {
    const response = await invoke<any>('test_mcp_sse', { endpoint, apiKey, env });
    return response;
  } catch (error) {
    console.error('Failed to test MCP SSE connection:', error);
    throw new Error(`Failed to test MCP SSE connection: ${error}`);
  }
}

export async function testMcpHttp(endpoint: string, apiKey: string, env?: Record<string, string>): Promise<any> {
  try {
    const response = await invoke<any>('test_mcp_http', { endpoint, apiKey, env });
    return response;
  } catch (error) {
    console.error('Failed to test MCP HTTP connection:', error);
    throw new Error(`Failed to test MCP HTTP connection: ${error}`);
  }
}

export async function testMcpModelScope(serverId: string, apiKey: string, region: string, hosted: boolean): Promise<any> {
  try {
    const response = await invoke<any>('test_mcp_modelscope', { serverId, apiKey, region, hosted });
    return response;
  } catch (error) {
    console.error('Failed to test MCP ModelScope connection:', error);
    throw new Error(`Failed to test MCP ModelScope connection: ${error}`);
  }
}

export async function reloadMcpClient(): Promise<{ success: boolean; message?: string; error?: string }> {
  try {
    const response = await invoke<{ success: boolean; message?: string; error?: string }>('reload_mcp_client');
    return response;
  } catch (error) {
    console.error('Failed to reload MCP client:', error);
    throw new Error(`Failed to reload MCP client: ${error}`);
  }
}

// 外部搜索连通性测试
export async function testWebSearchConnectivity(engine?: string): Promise<any> {
  try {
    const response = await invoke<any>('test_web_search_connectivity', { engine: engine || null });
    return response;
  } catch (error) {
    console.error('Failed to test external search connection:', error);
    throw new Error(`Failed to test external search connection: ${error}`);
  }
}

// MCP 状态与工具
export async function getMcpStatus(): Promise<any> {
  try {
    return await invoke<any>('get_mcp_status');
  } catch (error) {
    console.error('Failed to get MCP status:', error);
    throw new Error(`Failed to get MCP status: ${error}`);
  }
}

export async function getMcpTools(): Promise<Array<{ name: string; description?: string; input_schema: any }>> {
  try {
    return await invoke<Array<{ name: string; description?: string; input_schema: any }>>('get_mcp_tools');
  } catch (error) {
    console.error('Failed to get MCP tools:', error);
    throw new Error(`Failed to get MCP tools: ${error}`);
  }
}

export async function testAllSearchEngines(): Promise<{
  results: Record<string, {
    name: string;
    status: 'success' | 'failed' | 'not_configured';
    message: string;
    elapsed_ms: number;
    results_count?: number;
  }>;
  summary: {
    total: number;
    configured: number;
    success: number;
    failed: number;
  };
  timestamp: string;
}> {
  try {
    return await invoke('test_all_search_engines');
  } catch (error) {
    console.error('Search engine health check failed:', error);
    throw new Error(`Search engine health check failed: ${error}`);
  }
}

export async function testApiConnection(apiKey: string, apiBase: string, model?: string): Promise<boolean> {
  try {
    const response = await invoke<boolean>('test_api_connection', {
      api_key: apiKey,
      api_base: apiBase,
      model: model || null,
    });
    return response;
  } catch (error) {
    console.error('Failed to test API connection:', error);
    throw new Error(`Failed to test API connection: ${error}`);
  }
}

// 获取增强版统计信息（包含所有模块）
// ★ 2026-06-13：后端 `get_statistics` 命令已随旧 Dashboard 移除；仅保留 get_enhanced_statistics。
export async function getEnhancedStatistics(): Promise<any> {
  try {
    const response = await invoke<any>('get_enhanced_statistics');
    return response;
  } catch (error) {
    console.error('Failed to get enhanced statistics:', error);
    throw new Error(`Failed to get enhanced statistics: ${error}`);
  }
}

// 文档31清理：getSupportedSubjects 已彻底删除
