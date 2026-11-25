/**
 * vendorModelService - 供应商模型获取与自动分配服务
 *
 * 从 VendorModelFetcher / SiliconFlowSection 中提取的纯 HTTP 获取逻辑，
 * 无 React 依赖，可在任意上下文中静默执行。
 *
 * 自动 Key 保存后的流程编排：resolveApiKey → fetchModels → addModels → autoAssignAllModels
 * 所有错误仅 console 输出，不弹出通知。
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import i18n from '@/i18n';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { getErrorDetails, getErrorMessage } from '@/utils/errorUtils';
import { TauriAPI } from '@/utils/tauriApi';
import type { VendorConfig } from '@/types';

// ============================================================================
// 类型
// ============================================================================

export interface FetchedModel {
  id: string;
  label: string;
  /** 供应商元数据回填的上下文窗口（缺省时走能力推断） */
  contextWindow?: number;
  /** 供应商元数据回填的最大输出 token（缺省时走默认参数） */
  maxOutputTokens?: number;
}

/** 取第一个有限正整数（供应商字段命名不一，值可能缺失、为 0 或数字字符串）。 */
function firstPositive(...values: Array<number | string | undefined>): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return undefined;
}

/** 供应商模型列表 JSON 形状不对时的稳定错误码，由 UI 映射到 i18n */
export const INVALID_VENDOR_MODEL_RESPONSE = 'INVALID_VENDOR_MODEL_RESPONSE';

/** OpenAI 兼容 API 返回的模型对象 */
interface OpenAIModelItem {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  context_length?: number | string;
  context_window?: number | string;
  max_context_length?: number | string;
  max_model_len?: number | string;
  max_output_tokens?: number | string;
  max_completion_tokens?: number | string;
  top_provider?: { max_completion_tokens?: number | string };
}

/** Gemini API 返回的模型对象 */
interface GeminiModelItem {
  name: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
  inputTokenLimit?: number | string;
  outputTokenLimit?: number | string;
}

/** Anthropic API 返回的模型对象 */
interface AnthropicModelItem {
  id: string;
  display_name?: string;
  type?: string;
}

/** 添加模型的载荷：能力回填字段可选，缺省时由前端能力推断补齐。 */
export interface VendorModelAddPayload {
  modelId: string;
  label: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface AutoPostSaveOptions {
  /** 该供应商已有的模型 ID 列表，用于去重 */
  existingModelIds: string[];
  /** 添加模型到持久化的回调（对应 useSettingsVendorState.handleAddVendorModels） */
  onAddModels: (
    vendor: VendorConfig,
    models: VendorModelAddPayload[]
  ) => Promise<void>;
}

// ============================================================================
// Helper
// ============================================================================

const isStreamChannelError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('fetch_read_body') && message.includes('streamChannel');
};

const LEGACY_VENDOR_FETCH_PREFIX = /^(?:获取供应商模型失败|解析供应商模型响应失败)\s*[:：]\s*/u;
const LEGACY_INVALID_RESPONSE_MESSAGES = new Set([
  INVALID_VENDOR_MODEL_RESPONSE,
  'Gemini 模型响应缺少 models 数组',
  '供应商模型响应缺少 data 数组',
]);

function extractNestedCauseDetail(error: unknown, depth = 0): string {
  if (depth > 4 || error === null || error === undefined) return '';
  if (typeof error === 'string') return error.trim();
  if (typeof error !== 'object') return String(error).trim();
  const record = error as {
    message?: unknown;
    code?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  const code = typeof record.code === 'string' && record.code.trim() !== '' ? record.code.trim() : '';
  const parts: string[] = [];
  if (message) parts.push(message);
  if (code && !message.includes(code)) parts.push(code);
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    const sub = [...new Set(
      record.errors
        .map((entry) => extractNestedCauseDetail(entry, depth + 1))
        .filter((text) => text.length > 0)
    )];
    if (sub.length > 0) parts.push(sub.join('; '));
  }
  if (record.cause !== undefined && record.cause !== error) {
    const nested = extractNestedCauseDetail(record.cause, depth + 1);
    if (nested && !parts.some((part) => part.includes(nested))) {
      parts.push(nested);
    }
  }
  return parts.join(': ');
}

/**
 * Extract actionable, locale-neutral network/HTTP error detail from IPC plain objects,
 * `Error` instances (including `cause` / `AggregateError`), or strings without degrading
 * structured host errors to "Unknown error".
 */
export function formatVendorModelFetchError(
  error: unknown,
  translate?: (key: string, options?: Record<string, unknown>) => string,
): string {
  const tr = translate ?? ((key: string, options?: Record<string, unknown>) => String(i18n.t(key, options)));
  const unknownFallback = tr('common:error.unknown_error', { defaultValue: 'Unknown error' });

  if (error === null || error === undefined) {
    return unknownFallback;
  }

  let raw = '';
  const details = getErrorDetails(error);
  if (details.message || details.detail || details.code) {
    raw = getErrorMessage(error).trim();
  } else if (typeof error === 'object') {
    const nested = extractNestedCauseDetail(error);
    if (nested) {
      raw = nested;
    } else {
      try {
        const json = JSON.stringify(error);
        if (json && json !== '{}') raw = getErrorMessage(error).trim();
      } catch {
        raw = '';
      }
    }
  } else {
    raw = getErrorMessage(error).trim();
  }

  if (error && typeof error === 'object') {
    const record = error as { cause?: unknown; errors?: unknown };
    const extraParts: string[] = [];
    if (Array.isArray(record.errors) && record.errors.length > 0) {
      const sub = [...new Set(
        record.errors
          .map((entry) => extractNestedCauseDetail(entry, 1))
          .filter((text) => text.length > 0)
      )];
      if (sub.length > 0) extraParts.push(sub.join('; '));
    }
    if (record.cause !== undefined && record.cause !== error) {
      const causeText = extractNestedCauseDetail(record.cause, 1);
      if (causeText) extraParts.push(causeText);
    }
    for (const extra of extraParts) {
      if (extra && !raw.includes(extra)) {
        raw = raw ? `${raw}: ${extra}` : extra;
      }
    }
  }

  const cleaned = raw.replace(LEGACY_VENDOR_FETCH_PREFIX, '').trim();
  if (!cleaned) {
    return unknownFallback;
  }
  if (LEGACY_INVALID_RESPONSE_MESSAGES.has(cleaned)) {
    return tr('settings:vendor_model_fetcher.invalid_response', {
      defaultValue: 'Invalid API response format',
    });
  }
  return cleaned;
}

async function readHttpErrorDetail(response: Response): Promise<string> {
  const text = (await response.text().catch(() => '')).trim();
  if (text) {
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: unknown } | string;
        message?: unknown;
        detail?: unknown;
      };
      if (
        typeof parsed?.error === 'object'
        && parsed.error !== null
        && typeof parsed.error.message === 'string'
        && parsed.error.message.trim()
      ) {
        return parsed.error.message.trim();
      }
      if (typeof parsed?.error === 'string' && parsed.error.trim()) return parsed.error.trim();
      if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message.trim();
      if (typeof parsed?.detail === 'string' && parsed.detail.trim()) return parsed.detail.trim();
    } catch {
      // Non-JSON text body
    }
    return text.slice(0, 500);
  }
  return response.statusText || `HTTP ${response.status}`;
}

/**
 * Merge user-configured vendor headers with headers required by the selected
 * transport. Transport headers win case-insensitively so a stale custom
 * `authorization` value cannot replace the active API key.
 */
export function mergeVendorModelRequestHeaders(
  vendorHeaders: Record<string, string> | undefined,
  transportHeaders: Record<string, string>
): Record<string, string> {
  const merged: Record<string, string> = { ...(vendorHeaders ?? {}) };

  for (const [transportName, transportValue] of Object.entries(transportHeaders)) {
    for (const existingName of Object.keys(merged)) {
      if (existingName.toLowerCase() === transportName.toLowerCase()) {
        delete merged[existingName];
      }
    }
    merged[transportName] = transportValue;
  }

  return merged;
}

/** Build an OpenAI-compatible model-list URL from either a root/base URL or a request endpoint. */
export function buildVendorModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  const pathWithoutTrailingSlash = url.pathname.replace(/\/+$/u, '');
  const endpointRoot = pathWithoutTrailingSlash.replace(
    /\/(?:chat\/completions|responses|models)$/iu,
    ''
  );
  url.pathname = `${endpointRoot.replace(/\/+$/u, '')}/models`;
  url.hash = '';
  return url.toString();
}

// ============================================================================
// 1. resolveApiKey - 解析供应商的真实 API Key
// ============================================================================

/**
 * 解析供应商的明文 API Key。
 * 内置供应商 → 优先从 Tauri 安全存储读取，回退到 vendor.apiKey
 * 普通供应商 → 直接返回（排除掩码 ***）
 * authMode=none（兼容 noApiKey）供应商 → 返回空字符串（允许无 Key 获取模型）
 */
export async function resolveApiKey(vendor: VendorConfig): Promise<string | null> {
  // 免密供应商：authMode 是持久化契约，noApiKey 仅用于兼容旧前端状态。
  if (vendor.authMode === 'none' || vendor.noApiKey) {
    return '';
  }
  const submittedKey = [vendor.apiKey, ...(vendor.apiKeys ?? [])]
    .map(key => key?.trim() ?? '')
    .find(key => key && key !== '***' && !key.split('').every(character => character === '*'));

  const isBuiltin = vendor.isBuiltin || vendor.id.startsWith('builtin-');

  if (isBuiltin) {
    try {
      let key = await TauriAPI.getSetting(`${vendor.id}.api_key`);
      // 兼容 SiliconFlow 旧格式
      if (!key && vendor.id === 'builtin-siliconflow') {
        key = await TauriAPI.getSetting('siliconflow.api_key');
      }
      // 回退：Tauri 存储为空时，检查 vendor.apiKey（handleSaveVendorApiKey 临时存入）
      if (!key && submittedKey) return submittedKey;
      return key && key.trim() ? key.trim() : null;
    } catch {
      debugLog.warn(`[vendorModelService] Failed to resolve builtin API key for ${vendor.id}`);
      return submittedKey ?? null;
    }
  }

  return submittedKey ?? null;
}

// ============================================================================
// 2. fetchModelsFromVendor - 从供应商 API 获取模型列表
// ============================================================================

/**
 * 从供应商 API 获取模型列表
 * Gemini/Google → 使用 {baseUrl}/v1beta/models，过滤 generateContent
 * Anthropic → 使用 {baseUrl}/v1/models + x-api-key/anthropic-version 头
 * 其他 → 使用 {baseUrl}/models Bearer auth，过滤非文本模型
 */
export async function fetchModelsFromVendor(
  vendor: VendorConfig,
  resolvedApiKey: string
): Promise<FetchedModel[]> {
  if (
    typeof window !== 'undefined'
    && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
    && vendor.id.trim()
  ) {
    return tauriInvoke<FetchedModel[]>('fetch_vendor_models', {
      vendorId: vendor.id,
    });
  }

  const baseUrl = vendor.baseUrl.trim().replace(/\/+$/u, '');
  if (!baseUrl) {
    throw new Error('Vendor base URL is empty');
  }

  const providerTypeLower = (vendor.providerType ?? '').toLowerCase();
  // 「选 Google 类型获取模型 404」修复：google 与 gemini 均走 Gemini 原生列表接口
  const isGemini = providerTypeLower === 'gemini' || providerTypeLower === 'google';
  const isAnthropic = providerTypeLower === 'anthropic';

  const doFetch = async (fetcher: typeof fetch): Promise<FetchedModel[]> => {
    if (isGemini) {
      return fetchGemini(fetcher, baseUrl, resolvedApiKey, vendor.headers);
    }
    if (isAnthropic) {
      return fetchAnthropic(fetcher, baseUrl, resolvedApiKey, vendor.headers);
    }
    return fetchOpenAICompatible(fetcher, baseUrl, resolvedApiKey, vendor.headers);
  };

  try {
    return await doFetch(tauriFetch as typeof fetch);
  } catch (err: unknown) {
    if (isStreamChannelError(err) || (err instanceof Error && err.message === 'TAURI_HTTP_READ_BODY_FAILED')) {
      return await doFetch(fetch);
    }
    throw err;
  }
}

/** 获取 OpenAI 兼容 API 的模型列表 */
async function fetchOpenAICompatible(
  doFetch: typeof fetch,
  baseUrl: string,
  apiKey: string,
  vendorHeaders?: Record<string, string>
): Promise<FetchedModel[]> {
  const headers = mergeVendorModelRequestHeaders(
    vendorHeaders,
    apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  );
  const response = await doFetch(buildVendorModelsUrl(baseUrl), {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const detail = await readHttpErrorDetail(response);
    throw new Error(`${response.status}: ${detail}`);
  }

  let body: { data?: OpenAIModelItem[] };
  try {
    body = await response.json();
  } catch (err: unknown) {
    if (isStreamChannelError(err)) {
      throw new Error('TAURI_HTTP_READ_BODY_FAILED');
    }
    throw err;
  }

  if (!body?.data || !Array.isArray(body.data)) {
    throw new Error(INVALID_VENDOR_MODEL_RESPONSE);
  }

  return body.data
    .filter((m: OpenAIModelItem) => typeof m?.id === 'string' && m.id.trim().length > 0)
    .filter((m: OpenAIModelItem) => {
      const lower = m.id.trim().toLowerCase();
      return (
        !lower.includes('tts') &&
        !lower.includes('whisper') &&
        !lower.includes('video') &&
        !lower.includes('kolors') &&
        !lower.includes('flux') &&
        !lower.includes('dall-e') &&
        !lower.includes('audio')
      );
    })
    .map((m: OpenAIModelItem) => {
      const id = m.id.trim();
      return {
        id,
        label: id,
        contextWindow: firstPositive(
          m.context_length,
          m.context_window,
          m.max_context_length,
          m.max_model_len
        ),
        maxOutputTokens: firstPositive(
          m.max_output_tokens,
          m.max_completion_tokens,
          m.top_provider?.max_completion_tokens
        ),
      };
    })
    .sort((a: FetchedModel, b: FetchedModel) => a.id.localeCompare(b.id));
}

/** 获取 Google Gemini API 的模型列表 */
async function fetchGemini(
  doFetch: typeof fetch,
  baseUrl: string,
  apiKey: string,
  vendorHeaders?: Record<string, string>
): Promise<FetchedModel[]> {
  // 安全修复（审阅 26 P1-3）：Key 改用 x-goog-api-key 请求头传递，
  // 避免进入代理/网关/供应商访问日志，且规避 URL 特殊字符导致的畸形请求。
  const headers = mergeVendorModelRequestHeaders(
    vendorHeaders,
    apiKey ? { 'x-goog-api-key': apiKey } : {}
  );
  const response = await doFetch(`${baseUrl}/v1beta/models?pageSize=100`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const detail = await readHttpErrorDetail(response);
    throw new Error(`${response.status}: ${detail}`);
  }

  let body: { models?: GeminiModelItem[] };
  try {
    body = await response.json();
  } catch (err: unknown) {
    if (isStreamChannelError(err)) {
      throw new Error('TAURI_HTTP_READ_BODY_FAILED');
    }
    throw err;
  }

  if (!body?.models || !Array.isArray(body.models)) {
    throw new Error(INVALID_VENDOR_MODEL_RESPONSE);
  }

  return body.models
    .filter((m: GeminiModelItem) => typeof m?.name === 'string' && m.supportedGenerationMethods?.includes('generateContent'))
    .map((m: GeminiModelItem) => {
      const modelId = m.name.replace(/^models\//, '').trim();
      return {
        id: modelId,
        label: m.displayName?.trim() || modelId,
        contextWindow: firstPositive(m.inputTokenLimit),
        maxOutputTokens: firstPositive(m.outputTokenLimit),
      };
    })
    .filter((m: FetchedModel) => m.id.length > 0)
    .sort((a: FetchedModel, b: FetchedModel) => a.id.localeCompare(b.id));
}

/**
 * 获取 Anthropic API 的模型列表。
 * Anthropic 使用 GET {base}/v1/models + `x-api-key` + `anthropic-version` 头
 * （Bearer 鉴权与不带 /v1 的路径都会失败，见 2026-07 审阅 r4 #10）。
 */
async function fetchAnthropic(
  doFetch: typeof fetch,
  baseUrl: string,
  apiKey: string,
  vendorHeaders?: Record<string, string>
): Promise<FetchedModel[]> {
  // 默认 base URL 为 https://api.anthropic.com（不带版本段）；若用户已带 /v1 则不重复追加
  const versionedBase = /\/v\d+$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
  const headers = mergeVendorModelRequestHeaders(vendorHeaders, {
    'anthropic-version': '2023-06-01',
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
  });
  const response = await doFetch(`${versionedBase}/models?limit=1000`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const detail = await readHttpErrorDetail(response);
    throw new Error(`${response.status}: ${detail}`);
  }

  let body: { data?: AnthropicModelItem[] };
  try {
    body = await response.json();
  } catch (err: unknown) {
    if (isStreamChannelError(err)) {
      throw new Error('TAURI_HTTP_READ_BODY_FAILED');
    }
    throw err;
  }

  if (!body?.data || !Array.isArray(body.data)) {
    throw new Error(INVALID_VENDOR_MODEL_RESPONSE);
  }

  return body.data
    .filter((m: AnthropicModelItem) => typeof m?.id === 'string' && m.id.trim().length > 0 && (m.type === undefined || m.type === 'model'))
    .map((m: AnthropicModelItem) => {
      const id = m.id.trim();
      return { id, label: m.display_name?.trim() || id };
    })
    .sort((a: FetchedModel, b: FetchedModel) => a.id.localeCompare(b.id));
}

// ============================================================================
// 3. autoPostSaveFlow - 自动编排：获取模型 → 添加模型 → 自动分配
// ============================================================================

/**
 * API Key 保存后的自动流程编排：
 * 1. resolveApiKey - 获取明文 Key
 * 2. fetchModelsFromVendor - 从供应商 API 获取模型列表
 * 3. onAddModels - 将新模型持久化为 ModelProfile（跳过已存在）
 * 4. autoAssignAllModels - 自动分配到空槽位
 *
 * 预期网络失败走 debugLog.warn + 本地化 UI 提示，不向控制台抛未处理 console.error。
 * 如某个步骤失败，后续步骤不再执行。
 */
export async function autoPostSaveFlow(
  vendor: VendorConfig,
  options: AutoPostSaveOptions
): Promise<void> {
  const { existingModelIds, onAddModels } = options;

  // 1. Tauri 运行时由 Rust 解析凭据；浏览器回退路径才读取当前表单中的明文 key。
  const isTauri = typeof window !== 'undefined'
    && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  const resolvedKey = isTauri ? '' : await resolveApiKey(vendor);
  if (resolvedKey === null) {
    debugLog.warn(
      `[autoPostSaveFlow] Cannot resolve API key for vendor ${vendor.id} (${vendor.name}), skipping auto-fetch.`
    );
    return;
  }

  // 2. 获取模型列表
  let fetchedModels: FetchedModel[];
  try {
    fetchedModels = await fetchModelsFromVendor(vendor, resolvedKey);
  } catch (err) {
    const errorDetail = formatVendorModelFetchError(err);
    debugLog.warn(
      `[autoPostSaveFlow] Failed to fetch models for vendor ${vendor.id} (${vendor.name}): ${errorDetail}`,
      err
    );
    showGlobalNotification(
      'warning',
      i18n.t('settings:vendor_model_fetcher.fetch_failed', {
        error: errorDetail,
        defaultValue: `Failed to fetch model list: ${errorDetail}`,
      })
    );
    return;
  }

  if (fetchedModels.length === 0) {
    debugLog.warn(`[autoPostSaveFlow] No models returned for vendor ${vendor.id}, skipping add.`);
    return;
  }

  // 3. 只添加尚未存在的新模型
  const existingSet = new Set(existingModelIds.map(id => id.trim().toLowerCase()));
  const newModels = vendor.id === 'builtin-mistral'
    ? []
    : fetchedModels.filter(m => m.id.trim().length > 0 && !existingSet.has(m.id.trim().toLowerCase()));

  if (newModels.length > 0) {
    try {
      await onAddModels(
        vendor,
        newModels.map(m => ({
          modelId: m.id.trim(),
          label: m.label.trim() || m.id.trim(),
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
        }))
      );
      debugLog.log(
        `[autoPostSaveFlow] Added ${newModels.length} models for vendor ${vendor.id} (${vendor.name})`
      );
    } catch (err) {
      debugLog.warn(
        `[autoPostSaveFlow] Failed to persist models for vendor ${vendor.id}:`,
        err
      );
      return;
    }
  }

  // 4. 自动分配模型到空槽位
  try {
    const { autoAssignAllModels } = await import(
      '@/features/chat/readiness/autoAssignModel'
    );
    const result = await autoAssignAllModels();
    if (result.assigned) {
      debugLog.log(
        `[autoPostSaveFlow] Auto-assigned ${result.assignedCount} model(s): ${result.assignedModelNames.join(', ')}`
      );
    } else {
      debugLog.log(
        `[autoPostSaveFlow] Auto-assign skipped or no models available: ${result.reason ?? 'unknown'}`
      );
    }
  } catch (err) {
    debugLog.warn('[autoPostSaveFlow] Auto-assignment failed:', err);
  }
}
