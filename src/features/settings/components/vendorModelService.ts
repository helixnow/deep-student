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
import { TauriAPI } from '@/utils/tauriApi';
import type { VendorConfig } from '@/types';

// ============================================================================
// 类型
// ============================================================================

export interface FetchedModel {
  id: string;
  label: string;
}

/** OpenAI 兼容 API 返回的模型对象 */
interface OpenAIModelItem {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

/** Gemini API 返回的模型对象 */
interface GeminiModelItem {
  name: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
}

/** Anthropic API 返回的模型对象 */
interface AnthropicModelItem {
  id: string;
  display_name?: string;
  type?: string;
}

export interface AutoPostSaveOptions {
  /** 该供应商已有的模型 ID 列表，用于去重 */
  existingModelIds: string[];
  /** 添加模型到持久化的回调（对应 useSettingsVendorState.handleAddVendorModels） */
  onAddModels: (
    vendor: VendorConfig,
    models: Array<{ modelId: string; label: string }>
  ) => Promise<void>;
}

// ============================================================================
// Helper
// ============================================================================

const isStreamChannelError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('fetch_read_body') && message.includes('streamChannel');
};

// ============================================================================
// 1. resolveApiKey - 解析供应商的真实 API Key
// ============================================================================

/**
 * 解析供应商的明文 API Key。
 * 内置供应商 → 优先从 Tauri 安全存储读取，回退到 vendor.apiKey
 * 普通供应商 → 直接返回（排除掩码 ***）
 * noApiKey 供应商 → 返回空字符串（允许无 Key 获取模型）
 */
export async function resolveApiKey(vendor: VendorConfig): Promise<string | null> {
  // noApiKey 供应商：无需 Key，返回空字符串表示"可跳过认证"
  if (vendor.noApiKey) {
    return '';
  }

  const isBuiltin = vendor.isBuiltin || vendor.id.startsWith('builtin-');

  if (isBuiltin) {
    try {
      let key = await TauriAPI.getSetting(`${vendor.id}.api_key`);
      // 兼容 SiliconFlow 旧格式
      if (!key && vendor.id === 'builtin-siliconflow') {
        key = await TauriAPI.getSetting('siliconflow.api_key');
      }
      // 回退：Tauri 存储为空时，检查 vendor.apiKey（handleSaveVendorApiKey 临时存入）
      if (!key) {
        const raw = vendor.apiKey?.trim();
        if (raw && raw !== '***' && !raw.split('').every(c => c === '*')) {
          return raw;
        }
      }
      return key && key.trim() ? key.trim() : null;
    } catch {
      console.warn(`[vendorModelService] Failed to resolve builtin API key for ${vendor.id}`);
      // 异常时回退到 vendor.apiKey
      const raw = vendor.apiKey?.trim();
      if (raw && raw !== '***' && !raw.split('').every(c => c === '*')) {
        return raw;
      }
      return null;
    }
  }

  const raw = vendor.apiKey?.trim();
  if (raw && raw !== '***' && !raw.split('').every(c => c === '*')) {
    return raw;
  }
  return null;
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
  const baseUrl = vendor.baseUrl.replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('Vendor base URL is empty');
  }

  const providerTypeLower = (vendor.providerType ?? '').toLowerCase();
  // 「选 Google 类型获取模型 404」修复：google 与 gemini 均走 Gemini 原生列表接口
  const isGemini = providerTypeLower === 'gemini' || providerTypeLower === 'google';
  const isAnthropic = providerTypeLower === 'anthropic';

  const doFetch = async (fetcher: typeof fetch): Promise<FetchedModel[]> => {
    if (isGemini) {
      return fetchGemini(fetcher, baseUrl, resolvedApiKey);
    }
    if (isAnthropic) {
      return fetchAnthropic(fetcher, baseUrl, resolvedApiKey);
    }
    return fetchOpenAICompatible(fetcher, baseUrl, resolvedApiKey);
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
  apiKey: string
): Promise<FetchedModel[]> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  const response = await doFetch(`${baseUrl}/models`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    let detail: string;
    try {
      detail = JSON.stringify(await response.json());
    } catch {
      detail = response.statusText || `HTTP ${response.status}`;
    }
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
    throw new Error('Invalid API response: missing data array');
  }

  return body.data
    .filter(
      (m: OpenAIModelItem) =>
        !m.id.includes('tts') &&
        !m.id.includes('whisper') &&
        !m.id.includes('video') &&
        !m.id.includes('kolors') &&
        !m.id.includes('flux') &&
        !m.id.includes('dall-e') &&
        !m.id.includes('audio')
    )
    .map((m: OpenAIModelItem) => ({ id: m.id, label: m.id }))
    .sort((a: FetchedModel, b: FetchedModel) => a.id.localeCompare(b.id));
}

/** 获取 Google Gemini API 的模型列表 */
async function fetchGemini(
  doFetch: typeof fetch,
  baseUrl: string,
  apiKey: string
): Promise<FetchedModel[]> {
  // 安全修复（审阅 26 P1-3）：Key 改用 x-goog-api-key 请求头传递，
  // 避免进入代理/网关/供应商访问日志，且规避 URL 特殊字符导致的畸形请求。
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['x-goog-api-key'] = apiKey;
  }
  const response = await doFetch(`${baseUrl}/v1beta/models?pageSize=100`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    let detail: string;
    try {
      detail = JSON.stringify(await response.json());
    } catch {
      detail = response.statusText || `HTTP ${response.status}`;
    }
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
    throw new Error('Invalid Gemini API response: missing models array');
  }

  return body.models
    .filter((m: GeminiModelItem) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m: GeminiModelItem) => {
      const modelId = m.name.replace(/^models\//, '');
      return { id: modelId, label: m.displayName || modelId };
    })
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
  apiKey: string
): Promise<FetchedModel[]> {
  // 默认 base URL 为 https://api.anthropic.com（不带版本段）；若用户已带 /v1 则不重复追加
  const versionedBase = /\/v\d+$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }
  const response = await doFetch(`${versionedBase}/models?limit=1000`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    let detail: string;
    try {
      detail = JSON.stringify(await response.json());
    } catch {
      detail = response.statusText || `HTTP ${response.status}`;
    }
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
    throw new Error('Invalid Anthropic API response: missing data array');
  }

  return body.data
    .filter((m: AnthropicModelItem) => !!m.id && (m.type === undefined || m.type === 'model'))
    .map((m: AnthropicModelItem) => ({ id: m.id, label: m.display_name || m.id }))
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
 * 所有错误仅 console.error，不弹出通知（静默执行）。
 * 如某个步骤失败，后续步骤不再执行。
 */
export async function autoPostSaveFlow(
  vendor: VendorConfig,
  options: AutoPostSaveOptions
): Promise<void> {
  const { existingModelIds, onAddModels } = options;

  // 1. 解析 API Key
  const resolvedKey = await resolveApiKey(vendor);
  // noApiKey 供应商返回空字符串（而非 null），允许无 Key 获取模型
  if (resolvedKey === null) {
    console.warn(
      `[autoPostSaveFlow] Cannot resolve API key for vendor ${vendor.id} (${vendor.name}), skipping auto-fetch.`
    );
    return;
  }

  // 2. 获取模型列表
  let fetchedModels: FetchedModel[];
  try {
    fetchedModels = await fetchModelsFromVendor(vendor, resolvedKey);
  } catch (err) {
    console.error(
      `[autoPostSaveFlow] Failed to fetch models for vendor ${vendor.id} (${vendor.name}):`,
      err
    );
    return;
  }

  if (fetchedModels.length === 0) {
    console.warn(`[autoPostSaveFlow] No models returned for vendor ${vendor.id}, skipping add.`);
    return;
  }

  // 3. 只添加尚未存在的新模型
  const existingSet = new Set(existingModelIds.map(id => id.toLowerCase()));
  const newModels = fetchedModels.filter(m => !existingSet.has(m.id.toLowerCase()));

  if (newModels.length === 0) {
    console.log(`[autoPostSaveFlow] All ${fetchedModels.length} models already exist for vendor ${vendor.id}, skipping add.`);
  } else {
    try {
      await onAddModels(
        vendor,
        newModels.map(m => ({ modelId: m.id, label: m.label }))
      );
      console.log(
        `[autoPostSaveFlow] Added ${newModels.length} models for vendor ${vendor.id} (${vendor.name})`
      );
    } catch (err) {
      console.error(
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
      console.log(
        `[autoPostSaveFlow] Auto-assigned ${result.assignedCount} model(s): ${result.assignedModelNames.join(', ')}`
      );
    } else {
      console.log(
        `[autoPostSaveFlow] Auto-assign skipped or no models available: ${result.reason ?? 'unknown'}`
      );
    }
  } catch (err) {
    console.error('[autoPostSaveFlow] Auto-assignment failed:', err);
  }
}
