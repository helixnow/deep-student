import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './shared';
// ★ 2026-07-08（审计 30-P1-2）：错误重抛统一走 getErrorMessage，
// 避免 `${error}` 对对象错误产生 "[object Object]"，且保留结构化 message 可解析性
import { getErrorMessage } from './errorUtils';

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
    throw new Error(`Failed to save setting: ${getErrorMessage(error)}`);
  }
}

export async function getSetting(key: string): Promise<string | null> {
  if (!isTauriRuntime) {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  }
  try {
    const response = await invoke<string | null>('get_setting', { key });
    return response;
  } catch (error) {
    // 宽松读取仅供展示路径：Tauri 运行时的 IPC 失败回退 localStorage（通常
    // 为 null）。注意：写路径/回滚基线必须使用 getSettingStrict——把"读失败"
    // 当"键不存在"会让 saveSettings 用错误基线回滚（2026-09-07 审阅 N06）。
    console.error('Failed to get setting:', error);
    const fallback = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    return fallback;
  }
}

/** Strict read: native IPC errors propagate instead of switching authority. */
async function getSettingStrict(key: string): Promise<string | null> {
  if (!isTauriRuntime) {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  }
  try {
    return await invoke<string | null>('get_setting', { key });
  } catch (error) {
    throw new Error(`Failed to get setting: ${getErrorMessage(error)}`);
  }
}

/** Read a group of settings with identical fallback semantics. */
export async function getSettings(keys: readonly string[]): Promise<Record<string, string | null>> {
  const entries = await Promise.all(keys.map(async (key) => [key, await getSetting(key)] as const));
  return Object.fromEntries(entries);
}

/** Persist a group of settings without exposing raw IPC details to callers. */
export async function saveSettings(settings: Record<string, string>): Promise<void> {
  const entries = Object.entries(settings);
  // N06（2026-09-07 审阅）：回滚基线必须严格读取——任一基线读取失败都在
  // 写入之前抛出，绝不把"读失败"当"原本不存在"而在回滚时误删原生值。
  const previous: Record<string, string | null> = {};
  for (const [key] of entries) {
    previous[key] = await getSettingStrict(key);
  }
  const applied: string[] = [];
  try {
    for (const [key, value] of entries) {
      await saveSetting(key, value);
      applied.push(key);
    }
  } catch (error) {
    // 尽力回滚：单个补偿失败不中止其余补偿，最终抛出原始错误。
    for (const key of applied.reverse()) {
      const oldValue = previous[key];
      try {
        if (oldValue == null) await deleteSetting(key);
        else await saveSetting(key, oldValue);
      } catch (rollbackError) {
        console.error(`Failed to roll back setting "${key}":`, rollbackError);
      }
    }
    throw error;
  }
}

export async function deleteSetting(key: string): Promise<void> {
  if (!isTauriRuntime) {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(key);
    }
    return;
  }
  try {
    await invoke<boolean>('delete_setting', { key });
  } catch (error) {
    // N06：原生删除失败必须可见——只清 localStorage 并正常返回会让调用方
    // 以为权威存储已删除（Promise 成功 ≠ 删除成功）。
    console.error('Failed to delete setting:', error);
    throw new Error(`Failed to delete setting: ${getErrorMessage(error)}`);
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
    throw new Error(`Failed to test MCP connection: ${getErrorMessage(error)}`);
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
    throw new Error(`Failed to test MCP WebSocket connection: ${getErrorMessage(error)}`);
  }
}

export async function testMcpSse(endpoint: string, apiKey: string, env?: Record<string, string>): Promise<any> {
  try {
    const response = await invoke<any>('test_mcp_sse', { endpoint, apiKey, env });
    return response;
  } catch (error) {
    console.error('Failed to test MCP SSE connection:', error);
    throw new Error(`Failed to test MCP SSE connection: ${getErrorMessage(error)}`);
  }
}

export async function testMcpHttp(endpoint: string, apiKey: string, env?: Record<string, string>): Promise<any> {
  try {
    const response = await invoke<any>('test_mcp_http', { endpoint, apiKey, env });
    return response;
  } catch (error) {
    console.error('Failed to test MCP HTTP connection:', error);
    throw new Error(`Failed to test MCP HTTP connection: ${getErrorMessage(error)}`);
  }
}

export async function testMcpModelScope(serverId: string, apiKey: string, region: string, hosted: boolean): Promise<any> {
  try {
    const response = await invoke<any>('test_mcp_modelscope', { serverId, apiKey, region, hosted });
    return response;
  } catch (error) {
    console.error('Failed to test MCP ModelScope connection:', error);
    throw new Error(`Failed to test MCP ModelScope connection: ${getErrorMessage(error)}`);
  }
}

export async function reloadMcpClient(): Promise<{ success: boolean; message?: string; error?: string }> {
  try {
    const response = await invoke<{ success: boolean; message?: string; error?: string }>('reload_mcp_client');
    return response;
  } catch (error) {
    console.error('Failed to reload MCP client:', error);
    throw new Error(`Failed to reload MCP client: ${getErrorMessage(error)}`);
  }
}

// 外部搜索连通性测试
export async function testWebSearchConnectivity(engine?: string): Promise<any> {
  try {
    const response = await invoke<any>('test_web_search_connectivity', { engine: engine || null });
    return response;
  } catch (error) {
    console.error('Failed to test external search connection:', error);
    throw new Error(`Failed to test external search connection: ${getErrorMessage(error)}`);
  }
}

// MCP 状态与工具
export async function getMcpStatus(): Promise<any> {
  try {
    return await invoke<any>('get_mcp_status');
  } catch (error) {
    console.error('Failed to get MCP status:', error);
    throw new Error(`Failed to get MCP status: ${getErrorMessage(error)}`);
  }
}

export async function getMcpTools(): Promise<Array<{ name: string; description?: string; input_schema: any }>> {
  try {
    return await invoke<Array<{ name: string; description?: string; input_schema: any }>>('get_mcp_tools');
  } catch (error) {
    console.error('Failed to get MCP tools:', error);
    throw new Error(`Failed to get MCP tools: ${getErrorMessage(error)}`);
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
    throw new Error(`Search engine health check failed: ${getErrorMessage(error)}`);
  }
}

/** 设置页「测试连接」的结构化结果（对应后端 ConnectionTestOutcome）。 */
export interface ConnectionTestOutcome {
  ok: boolean;
  latencyMs: number;
  /** 失败分类：config / auth / billing / model_not_found / bad_request /
   *  rate_limit / timeout / server / network / format / provider_error */
  category?: string;
  message?: string;
  /** 软接受警告：端点可达但存在不确定性（如模型目录未列出该模型）。 */
  warning?: string;
}

export async function testApiConnection(apiKey: string, apiBase: string, model?: string, isEmbedding = false, isReranker = false): Promise<ConnectionTestOutcome> {
  try {
    return await invoke<ConnectionTestOutcome>('test_api_connection', {
      api_key: apiKey,
      api_base: apiBase,
      model: model || null,
      is_embedding: isEmbedding,
      is_reranker: isReranker,
    });
  } catch (error) {
    console.error('Failed to test API connection:', error);
    throw new Error(`Failed to test API connection: ${getErrorMessage(error)}`);
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
    throw new Error(`Failed to get enhanced statistics: ${getErrorMessage(error)}`);
  }
}

// 文档31清理：getSupportedSubjects 已彻底删除
