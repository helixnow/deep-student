import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime, withSessionId } from './shared';

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















export async function researchGetRound(sessionId: string, roundNo: number): Promise<any> {
  return await invoke('research_get_round', { ...withSessionId(sessionId), round_no: roundNo, roundNo });
}
export async function researchGetRoundVisualSummary(sessionId: string, roundNo: number): Promise<any> {
  return await invoke('research_get_round_visual_summary', { ...withSessionId(sessionId), round_no: roundNo, roundNo });
}
export async function researchDeleteRound(sessionId: string, roundNo: number, cleanCoverage?: boolean): Promise<string> {
  return await invoke('research_delete_round', { ...withSessionId(sessionId), round_no: roundNo, roundNo, clean_coverage: !!cleanCoverage });
}
export async function researchGenerateRoundReport(sessionId: string, roundNo: number, format?: string, options?: { include_plan?: boolean; include_summary?: boolean; include_citations?: boolean; include_metrics?: boolean; include_subagents?: boolean }): Promise<string> {
  const opts_json = options ? JSON.stringify(options) : null;
  return await invoke('research_generate_round_report', { ...withSessionId(sessionId), round_no: roundNo, roundNo, format: format || null, opts_json, optsJson: opts_json });
}
export async function researchSetRoundNote(sessionId: string, roundNo: number, note: string, tags?: string[]): Promise<string> {
  return await invoke('research_set_round_note', { ...withSessionId(sessionId), round_no: roundNo, roundNo, note, tags: tags || null });
}
export async function researchGetRoundNote(sessionId: string, roundNo: number): Promise<{ note?: string; tags?: string[] }> {
  return await invoke('research_get_round_note', { ...withSessionId(sessionId), round_no: roundNo, roundNo });
}
export async function researchGetRoundNotes(sessionId: string): Promise<{ items: Array<{ round_no: number; note?: string; tags?: string[] }> }> {
  return await invoke('research_get_round_notes', { ...withSessionId(sessionId) });
}
export async function researchGenerateSessionReport(sessionId: string, format?: string, options?: { include_plan?: boolean; include_summary?: boolean; include_citations?: boolean; include_metrics?: boolean; include_subagents?: boolean }, rounds?: number[]): Promise<string> {
  const opts_json = options ? JSON.stringify(options) : null;
  return await invoke('research_generate_session_report', { ...withSessionId(sessionId), format: format || null, opts_json, optsJson: opts_json, rounds: Array.isArray(rounds) ? rounds : null });
}


export async function researchGetChunkText(documentId: string, chunkIndex: number, sessionId: string): Promise<string | null> {
  const res = await invoke<{ text: string | null }>('research_get_chunk_text', { ...withSessionId(sessionId), document_id: documentId, documentId, chunk_index: chunkIndex, chunkIndex });
  return res?.text ?? null;
}

export async function researchGetChunkContext(documentId: string, chunkIndex: number, before: number, after: number, sessionId: string): Promise<Array<{chunk_index: number; text: string}>> {
  const res = await invoke<{ items: Array<{chunk_index: number; text: string}> }>('research_get_chunk_context', { ...withSessionId(sessionId), document_id: documentId, documentId, chunk_index: chunkIndex, chunkIndex, before, after });
  return res?.items || [];
}

export async function researchUpdateSessionOptions(sessionId: string, options: Record<string, any>): Promise<string> {
  const options_json = JSON.stringify(options || {});
  return await invoke('research_update_session_options', { req: { ...withSessionId(sessionId), options_json, optionsJson: options_json } });
}

export async function researchDeleteSession(sessionId: string): Promise<string> {
  // Some Tauri bindings may expect camelCase keys in generated bridges.
  // Send both to be robust across environments; extra keys are ignored.
  return await invoke('research_delete_session', { session_id: sessionId, sessionId });
}

// Utilities
export async function saveTextToFile(path: string, content: string): Promise<void> {
  await invoke('save_text_to_file', { path, content });
}

export async function researchRunUntil(sessionId: string, maxRounds?: number, minSelected?: number, silentApproval?: boolean): Promise<string> {
  return await invoke('research_run_until', { 
    ...withSessionId(sessionId), 
    max_rounds: maxRounds, maxRounds,
    min_selected: minSelected, minSelected,
    silent_approval: typeof silentApproval === 'boolean' ? silentApproval : null,
    silentApproval: typeof silentApproval === 'boolean' ? silentApproval : null
  });
}

export async function readFileText(path: string): Promise<string> {
  return await invoke<string>('read_file_text', { path });
}

export async function researchRunMacroRound(sessionId: string, keywords?: string[]): Promise<string> {
  return await invoke('research_run_macro', { ...withSessionId(sessionId), keywords: keywords || null });
}

export async function researchRunToFullCoverage(sessionId: string): Promise<string> {
  return await invoke('research_run_to_full_coverage', withSessionId(sessionId));
}

// Agent tool commands exposure
export async function researchAuditUserQuestions(params: { date_range?: [string, string]; keywords?: string[]; group_by?: 'topic'|'day'|'week'; limit?: number }): Promise<any> {
  const { date_range, keywords, group_by, limit } = params;
  return await invoke('research_audit_user_questions', { date_range: date_range || null, dateRange: date_range || null, keywords: keywords || null, group_by: group_by || null, groupBy: group_by || null, limit: typeof limit === 'number' ? limit : null });
}

export async function researchFindSimilarQuestions(questionText: string, topK: number = 8): Promise<any> {
  return await invoke('research_find_similar_questions', { question_text: questionText, questionText, top_k: topK, topK });
}

export async function researchGetFullChatHistory(documentId?: string, messageId?: string): Promise<any> {
  return await invoke('research_get_full_chat_history', { document_id: documentId || null, documentId: documentId || null, message_id: messageId || null, messageId: messageId || null });
}

export async function researchDeepReadByDocs(sessionId: string, documentIds: string[], contextThreshold?: number): Promise<string> {
  return await invoke('research_deep_read_by_docs', { ...withSessionId(sessionId), document_ids: documentIds, documentIds, context_threshold: contextThreshold || null, contextThreshold: contextThreshold || null });
}

export async function researchDeepReadByTag(sessionId: string, tag: string, contextThreshold?: number): Promise<string> {
  return await invoke('research_deep_read_by_tag', { ...withSessionId(sessionId), tag, context_threshold: contextThreshold || null, contextThreshold: contextThreshold || null });
}

// Precise token utilities (model-aware); fallbacks handled by backend
export async function researchCountTokensPrecise(documentIds: string[]): Promise<{ total_tokens: number; per_document: Array<{document_id: string; tokens: number}> }> {
  return await invoke('research_count_tokens', { document_ids: documentIds, documentIds, precise: true });
}

export async function researchGetFullContentPrecise(documentIds: string[]): Promise<{ items: Array<{document_id: string; content: string; tokens_estimate: number}> }> {
  return await invoke('research_get_full_content', { document_ids: documentIds, documentIds, precise: true });
}

// Research settings (scoped helpers)
export async function researchGetSetting(key: string): Promise<string | null> {
  return await invoke('research_get_setting', { key });
}
export async function researchSetSetting(key: string, value: string): Promise<string> {
  return await invoke('research_set_setting', { key, value });
}
export async function researchDeleteSetting(key: string): Promise<string> {
  return await invoke('research_delete_setting', { key });
}

export async function researchListArtifacts(sessionId: string, roundNo?: number): Promise<{items: Array<{id:number;round_no:number;agent:string;artifact_type:string;payload_json:string;size:number;created_at:string}>}> {
  return await invoke('research_list_artifacts', { ...withSessionId(sessionId), round_no: typeof roundNo === 'number' ? roundNo : null, roundNo: typeof roundNo === 'number' ? roundNo : null });
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

// 统计信息API
export async function getStatistics(): Promise<any> {
  try {
    const response = await invoke<any>('get_statistics');
    return response;
  } catch (error) {
    console.error('Failed to get statistics:', error);
    throw new Error(`Failed to get statistics: ${error}`);
  }
}

// 获取增强版统计信息（包含所有模块）
export async function getEnhancedStatistics(): Promise<any> {
  try {
    const response = await invoke<any>('get_enhanced_statistics');
    return response;
  } catch (error) {
    console.error('Failed to get enhanced statistics:', error);
    // 降级到基础统计
    return getStatistics();
  }
}

// 文档31清理：getSupportedSubjects 已彻底删除
