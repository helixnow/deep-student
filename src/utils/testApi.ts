import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from './errorUtils';
import { invokeWithDebug } from './shared';
import type { DatabaseInfo, TestDatabaseSwitchResponse, MistakeItem } from './types';

// 合并相邻的assistant消息：
// - 如果出现 [assistant(无内容但含工具/来源)] + [assistant(有内容)]，
//   则把前者的 tool_call/tool_result/overrides.multi_tool 以及 rag/graph/memory/web_search sources 合并到后者，删除前者。
function coalesceAssistantMessages(list: any[]): any[] {
  if (!Array.isArray(list) || list.length === 0) return list || [];
  const out: any[] = [];
  for (let i = 0; i < list.length; i++) {
    const cur = list[i];
    const next = list[i + 1];
    const isAssistant = (m: any) => (m && (m.role === 'assistant'));
    const contentOf = (m: any) => (typeof m?.content === 'string' ? m.content.trim() : '');
    const hasTools = (m: any) => Boolean(m?.tool_call || m?.tool_result || (m?.overrides && m.overrides.multi_tool));
    const hasSources = (m: any) => Boolean(
      (m?.rag_sources && m.rag_sources.length) ||
      (m?.graph_sources && m.graph_sources.length) ||
      (m?.memory_sources && m.memory_sources.length) ||
      (m?.web_search_sources && m.web_search_sources.length)
    );

    if (isAssistant(cur) && isAssistant(next) && !contentOf(cur) && contentOf(next)) {
      // 合并工具
      if (hasTools(cur)) {
        // 兼容字段：保留最后一次到 tool_call/tool_result；多轮存到 overrides.multi_tool
        next.tool_call = next.tool_call || cur.tool_call || undefined;
        next.tool_result = next.tool_result || cur.tool_result || undefined;
        const curMulti = cur?.overrides?.multi_tool;
        if (curMulti && Array.isArray(curMulti.tool_calls) || Array.isArray(curMulti?.tool_results)) {
          const ov = next.overrides || {};
          const nt = ov.multi_tool || { tool_calls: [], tool_results: [] };
          if (Array.isArray(curMulti.tool_calls)) nt.tool_calls = [...(nt.tool_calls || []), ...curMulti.tool_calls];
          if (Array.isArray(curMulti.tool_results)) nt.tool_results = [...(nt.tool_results || []), ...curMulti.tool_results];
          ov.multi_tool = nt;
          next.overrides = ov;
        }
      }
      // 合并来源
      if (hasSources(cur)) {
        if (Array.isArray(cur.rag_sources)) next.rag_sources = [...(next.rag_sources || []), ...cur.rag_sources];
        if (Array.isArray(cur.graph_sources)) next.graph_sources = [...(next.graph_sources || []), ...cur.graph_sources];
        if (Array.isArray(cur.memory_sources)) next.memory_sources = [...(next.memory_sources || []), ...cur.memory_sources];
        if (Array.isArray(cur.web_search_sources)) next.web_search_sources = [...(next.web_search_sources || []), ...cur.web_search_sources];
      }
      // 丢弃当前，推进索引
      i++; // 跳过 next 将在下面 push
      out.push(next);
      continue;
    }
    out.push(cur);
  }
  return out;
}
export async function clearMessageEmbeddings(ids: Array<string | number>): Promise<void> {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const payload = ids
    .map((id) => {
      if (typeof id === 'number') return id.toString();
      if (typeof id === 'string') return id.trim();
      return '';
    })
    .filter((val) => val.length > 0);
  if (payload.length === 0) return;
  await invoke('clear_message_embeddings', { messageIds: payload });
}

// ======================== 测试数据库管理 ========================

/**
 * 切换到测试数据库
 */
export async function switchToTestDatabase(): Promise<TestDatabaseSwitchResponse> {
  return await invokeWithDebug('switch_to_test_database', {}, { tag: 'test_db' });
}

/**
 * 重置测试数据库（删除并重新创建）
 */
export async function resetTestDatabase(): Promise<TestDatabaseSwitchResponse> {
  return await invokeWithDebug('reset_test_database', {}, { tag: 'test_db' });
}

/**
 * 切换回生产数据库
 */
export async function switchToProductionDatabase(): Promise<TestDatabaseSwitchResponse> {
  return await invokeWithDebug('switch_to_production_database', {}, { tag: 'test_db' });
}

/**
 * 获取当前数据库路径信息
 */
export async function getDatabaseInfo(): Promise<DatabaseInfo> {
  return await invokeWithDebug('get_database_info', {}, { tag: 'test_db' });
}

/**
 * 播种测试数据库
 */
export async function seedTestDatabase(config?: {
  create_basic_mistakes?: boolean;
  create_mistakes_with_chat?: boolean;
  create_mistakes_with_attachments?: boolean;
  create_diverse_mistakes?: boolean; // subject 已废弃
}): Promise<{
  success: boolean;
  mistakes_created: number;
  messages_created: number;
  errors: string[];
}> {
  return await invokeWithDebug('seed_test_database', { config: config || null }, { tag: 'test_db' });
}

export async function setTestRunId(testRunId: string): Promise<{ success: boolean; test_run_id: string }> {
  return await invokeWithDebug('set_test_run_id', { test_run_id: testRunId, testRunId }, { tag: 'test_run' });
}

export const TestDatabaseAPI = {
  switchToTest: switchToTestDatabase,
  reset: resetTestDatabase,
  switchToProduction: switchToProductionDatabase,
  getInfo: getDatabaseInfo,
  seed: seedTestDatabase,
};
// ======================== 翻译功能API ========================

/** OCR 默认超时（毫秒）— 后端渐进对冲：60s 引擎超时 + 10s 对冲间隔，前端留 buffer */
const OCR_DEFAULT_TIMEOUT_MS = 75_000;

/**
 * OCR提取文本（单页图片识别）
 * @param options - {imagePath?: string, imageBase64?: string}
 * @param timeoutMs - 超时毫秒数，默认 75s；0 表示不设超时
 */
export async function ocrExtractText(options: {
  imagePath?: string;
  imageBase64?: string;
}, timeoutMs: number = OCR_DEFAULT_TIMEOUT_MS): Promise<string> {
  const invokePromise = invoke<string>('ocr_extract_text', {
    image_path: options.imagePath || null,
    image_base64: options.imageBase64 || null,
    imagePath: options.imagePath || null, // 兼容驼峰命名
    imageBase64: options.imageBase64 || null,
  });

  if (timeoutMs <= 0) {
    try {
      return await invokePromise;
    } catch (error) {
      throw new Error(`OCR text extraction failed: ${getErrorMessage(error)}`);
    }
  }

  // ★ 可清理的超时 timer，避免 invoke 先完成时产生 unhandled rejection
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error('OCR_TIMEOUT')), timeoutMs);
  });

  try {
    const result = await Promise.race([invokePromise, timeoutPromise]);
    return result;
  } catch (error) {
    const message = getErrorMessage(error);
    if (message === 'OCR_TIMEOUT') {
      throw new Error('OCR_TIMEOUT');
    }
    throw new Error(`OCR text extraction failed: ${message}`);
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
  }
}

/**
// ★ 翻译 CRUD 命令已全部迁移至 DSTU/VFS（translationDstuAdapter）
// translateText / listTranslations / updateTranslation / deleteTranslation /
// toggleTranslationFavorite / rateTranslation / TranslationAPI 聚合对象均已删除

// ★ 白板库 API 已移除（白板模块废弃，2026-01 清理）
*/

/** @deprecated 错题库功能已废弃（2026-01 清理），仅保留存根供 dev test panels 使用 */
export async function getMistakeDetails(_id: string): Promise<MistakeItem | null> {
  console.warn('[DEPRECATED] getMistakeDetails is deprecated, migrate callers (2026-01 cleanup)');
  return null;
}
