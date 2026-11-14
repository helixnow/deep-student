import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { buildModelsUrl } from './providerConfig';
import { AMBIGUOUS_SK_CANDIDATE_IDS, BYOK_PRESETS } from './keyDetector';
import type {
  ByokEndpointProbeResult,
  ByokErrorCode,
  ByokProviderPreset,
  EmbeddingDimensionProbeResult,
  KeyDetectionResult,
  ProbedModelDescriptor,
} from './types';

const MODELS_TIMEOUT_MS = 6_000;
const RACE_MODELS_TIMEOUT_MS = 3_500;
const EMBEDDINGS_TIMEOUT_MS = 3_500;
const MIN_EMBEDDING_DIMENSION = 64;
const MAX_EMBEDDING_DIMENSION = 8_192;

const RERANK_MODEL_REGEX = /rerank|bge-reranker/i;
const EMBEDDING_MODEL_REGEX =
  /embed|bge-|gte-|text-embedding|jina-embeddings|m3e|bce-embedding/i;
const NON_CHAT_MEDIA_MODEL_REGEX =
  /\btts\b|cosyvoice|fish-speech|whisper|sensevoice|funasr|-asr\b|qwen3-asr|flux|dall-e|stable-diffusion|sdxl|kolors|cogview|cogvideo|wan2\.|hunyuanvideo|kling|suno|udio/i;

const PREFERRED_EMBEDDING_PATTERNS: readonly RegExp[] = [
  /qwen3-embedding-8b/i,
  /qwen3-embedding-4b/i,
  /qwen3-embedding-0\.6b/i,
  /(?:^|\/)bge-m3$/i,
  /bge-m3/i,
  /text-embedding-3-small/i,
  /text-embedding-3-large/i,
  /text-embedding-v4/i,
  /text-embedding-v3/i,
  /^embedding-3$/i,
  /gemini-embedding-001/i,
  /text-embedding-004/i,
];

interface OpenAIModelItem {
  id: string;
  context_length?: number | string;
  context_window?: number | string;
  max_context_length?: number | string;
  max_model_len?: number | string;
  max_output_tokens?: number | string;
  max_completion_tokens?: number | string;
  top_provider?: { max_completion_tokens?: number | string };
}

interface GeminiModelItem {
  name: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
  inputTokenLimit?: number | string;
  outputTokenLimit?: number | string;
}

interface AnthropicModelItem {
  id: string;
  display_name?: string;
  type?: string;
}

export class ByokProbeError extends Error {
  readonly code: ByokErrorCode;
  readonly httpStatus?: number;

  constructor(code: ByokErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'ByokProbeError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface ProbeEndpointOptions {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

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

function isStreamChannelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    (message.includes('fetch_read_body') && message.includes('streamChannel')) ||
    message === 'TAURI_HTTP_READ_BODY_FAILED'
  );
}

function isAbortOrTimeoutError(error: unknown): boolean {
  if (!error) return false;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('timeout') || message.includes('timed out') || message.includes('aborted');
}

function createTimedSignal(timeoutMs: number, externalSignal?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('Request timed out', 'TimeoutError'));
  }, timeoutMs);

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

async function executeFetch(
  url: string,
  init: RequestInit,
  customFetcher?: typeof fetch,
): Promise<Response> {
  if (customFetcher) {
    return customFetcher(url, init);
  }
  const hasTauriRuntime =
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

  if (!hasTauriRuntime) {
    return globalThis.fetch(url, init);
  }

  try {
    return await (tauriFetch as typeof fetch)(url, init);
  } catch (error) {
    if (isStreamChannelError(error)) {
      return globalThis.fetch(url, init);
    }
    throw error;
  }
}

export function buildOpenAiEmbeddingsUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  const pathWithoutTrailingSlash = url.pathname.replace(/\/+$/u, '');
  const endpointRoot = pathWithoutTrailingSlash.replace(
    /\/(?:chat\/completions|responses|models|embeddings)$/iu,
    '',
  );
  url.pathname = `${endpointRoot.replace(/\/+$/u, '')}/embeddings`;
  url.hash = '';
  return url.toString();
}

export function rankEmbeddingCandidates(
  candidates: readonly ProbedModelDescriptor[],
): ProbedModelDescriptor[] {
  const score = (modelId: string): number => {
    const idx = PREFERRED_EMBEDDING_PATTERNS.findIndex((pattern) => pattern.test(modelId));
    if (idx !== -1) return idx;
    // Deprioritize multimodal VL embeddings when probing text vector dimensions
    if (/\bvl\b|-vl-|multimodal/i.test(modelId)) {
      return PREFERRED_EMBEDDING_PATTERNS.length + 10;
    }
    return PREFERRED_EMBEDDING_PATTERNS.length + 1;
  };

  return [...candidates].sort((a, b) => {
    const diff = score(a.id) - score(b.id);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
}

interface DiscoveredCatalog {
  chatModels: ProbedModelDescriptor[];
  embeddingCandidates: ProbedModelDescriptor[];
  rerankCandidates: ProbedModelDescriptor[];
}

function classifyOpenAiCatalog(items: readonly OpenAIModelItem[]): DiscoveredCatalog {
  const chatModels: ProbedModelDescriptor[] = [];
  const embeddingCandidates: ProbedModelDescriptor[] = [];
  const rerankCandidates: ProbedModelDescriptor[] = [];

  for (const item of items) {
    if (!item?.id || typeof item.id !== 'string') continue;
    const id = item.id.trim();
    if (!id) continue;

    const descriptor: ProbedModelDescriptor = {
      id,
      label: id,
      contextWindow: firstPositive(
        item.context_length,
        item.context_window,
        item.max_context_length,
        item.max_model_len,
      ),
      maxOutputTokens: firstPositive(
        item.max_output_tokens,
        item.max_completion_tokens,
        item.top_provider?.max_completion_tokens,
      ),
    };

    if (RERANK_MODEL_REGEX.test(id)) {
      rerankCandidates.push(descriptor);
      continue;
    }
    if (EMBEDDING_MODEL_REGEX.test(id)) {
      embeddingCandidates.push(descriptor);
      continue;
    }
    if (NON_CHAT_MEDIA_MODEL_REGEX.test(id)) {
      continue;
    }
    chatModels.push(descriptor);
  }

  return { chatModels, embeddingCandidates, rerankCandidates };
}

async function fetchCatalogForPreset(
  preset: ByokProviderPreset,
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  options: ProbeEndpointOptions,
): Promise<DiscoveredCatalog> {
  const cleanBase = baseUrl.trim().replace(/\/+$/u, '');
  if (!cleanBase) {
    throw new ByokProbeError('probe_failed', 'Base URL is empty');
  }

  const timed = createTimedSignal(timeoutMs, options.signal);
  try {
    if (preset.providerType === 'gemini') {
      const geminiBase = /\/v1(?:beta)?$/u.test(cleanBase) ? cleanBase : `${cleanBase}/v1beta`;
      const response = await executeFetch(
        `${geminiBase}/models?pageSize=100`,
        {
          method: 'GET',
          headers: apiKey ? { 'x-goog-api-key': apiKey } : {},
          signal: timed.signal,
        },
        options.fetcher,
      );

      if (!response.ok) {
        if (response.status === 401 || response.status === 403 || response.status === 400) {
          throw new ByokProbeError('auth_failed', `HTTP ${response.status}`, response.status);
        }
        throw new ByokProbeError('probe_failed', `HTTP ${response.status}`, response.status);
      }

      const body = (await response.json()) as { models?: GeminiModelItem[] };
      const models = Array.isArray(body?.models) ? body.models : [];
      const chatModels: ProbedModelDescriptor[] = [];
      const embeddingCandidates: ProbedModelDescriptor[] = [];

      for (const item of models) {
        if (!item?.name) continue;
        const modelId = item.name.replace(/^models\//, '');
        const methods = item.supportedGenerationMethods ?? [];
        const descriptor: ProbedModelDescriptor = {
          id: modelId,
          label: item.displayName || modelId,
          contextWindow: firstPositive(item.inputTokenLimit),
          maxOutputTokens: firstPositive(item.outputTokenLimit),
        };
        if (methods.includes('embedContent')) {
          embeddingCandidates.push(descriptor);
        }
        if (methods.includes('generateContent') && !NON_CHAT_MEDIA_MODEL_REGEX.test(modelId)) {
          chatModels.push(descriptor);
        }
      }

      return { chatModels, embeddingCandidates, rerankCandidates: [] };
    }

    if (preset.providerType === 'anthropic') {
      const versionedBase = /\/v\d+$/u.test(cleanBase) ? cleanBase : `${cleanBase}/v1`;
      const response = await executeFetch(
        `${versionedBase}/models?limit=100`,
        {
          method: 'GET',
          headers: {
            'anthropic-version': '2023-06-01',
            ...(apiKey ? { 'x-api-key': apiKey } : {}),
          },
          signal: timed.signal,
        },
        options.fetcher,
      );

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new ByokProbeError('auth_failed', `HTTP ${response.status}`, response.status);
        }
        throw new ByokProbeError('probe_failed', `HTTP ${response.status}`, response.status);
      }

      const body = (await response.json()) as { data?: AnthropicModelItem[] };
      const items = Array.isArray(body?.data) ? body.data : [];
      const chatModels: ProbedModelDescriptor[] = items
        .filter((item) => Boolean(item?.id) && (item.type === undefined || item.type === 'model'))
        .map((item) => ({
          id: item.id,
          label: item.display_name || item.id,
        }));

      return { chatModels, embeddingCandidates: [], rerankCandidates: [] };
    }

    // OpenAI-compatible
    const modelsUrl = buildModelsUrl(cleanBase);
    const response = await executeFetch(
      modelsUrl,
      {
        method: 'GET',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: timed.signal,
      },
      options.fetcher,
    );

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new ByokProbeError('auth_failed', `HTTP ${response.status}`, response.status);
      }
      throw new ByokProbeError('probe_failed', `HTTP ${response.status}`, response.status);
    }

    const body = (await response.json()) as { data?: OpenAIModelItem[] };
    const items = Array.isArray(body?.data) ? body.data : [];
    return classifyOpenAiCatalog(items);
  } catch (error) {
    if (error instanceof ByokProbeError) {
      throw error;
    }
    if (isAbortOrTimeoutError(error)) {
      throw new ByokProbeError('network_timeout', 'Connection timed out');
    }
    throw new ByokProbeError(
      'probe_failed',
      'Endpoint request failed',
    );
  } finally {
    timed.cleanup();
  }
}

async function raceAmbiguousSkCandidates(
  candidates: readonly ByokProviderPreset[],
  apiKey: string,
  options: ProbeEndpointOptions,
): Promise<{ preset: ByokProviderPreset; catalog: DiscoveredCatalog }> {
  const candidatePresets =
    candidates.length > 0
      ? candidates
      : AMBIGUOUS_SK_CANDIDATE_IDS.map((id) => BYOK_PRESETS[id]);

  const raceController = new AbortController();
  const onParentAbort = () => raceController.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) {
      raceController.abort(options.signal.reason);
    } else {
      options.signal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  const errors: ByokProbeError[] = [];

  try {
    const winner = await Promise.any(
      candidatePresets.map(async (candidate) => {
        try {
          const catalog = await fetchCatalogForPreset(
            candidate,
            candidate.baseUrl,
            apiKey,
            RACE_MODELS_TIMEOUT_MS,
            {
              fetcher: options.fetcher,
              signal: raceController.signal,
            },
          );
          if (catalog.chatModels.length === 0 && catalog.embeddingCandidates.length === 0) {
            throw new ByokProbeError('no_models', 'No models returned');
          }
          raceController.abort();
          return { preset: candidate, catalog };
        } catch (err) {
          const normalized =
            err instanceof ByokProbeError
              ? err
              : new ByokProbeError(
                  isAbortOrTimeoutError(err) ? 'network_timeout' : 'probe_failed',
                  'Endpoint request failed',
                );
          errors.push(normalized);
          throw normalized;
        }
      }),
    );
    return winner;
  } catch {
    const authErr = errors.find((e) => e.code === 'auth_failed');
    if (authErr && errors.every((e) => e.code === 'auth_failed')) {
      throw authErr;
    }
    const noModelsErr = errors.find((e) => e.code === 'no_models');
    if (noModelsErr) {
      throw noModelsErr;
    }
    const timeoutErr = errors.find((e) => e.code === 'network_timeout');
    if (timeoutErr) {
      throw timeoutErr;
    }
    throw authErr ?? errors[0] ?? new ByokProbeError('probe_failed', 'All candidate endpoints failed');
  } finally {
    if (options.signal) {
      options.signal.removeEventListener('abort', onParentAbort);
    }
  }
}

async function probeSingleEmbeddingDimension(
  preset: ByokProviderPreset,
  baseUrl: string,
  apiKey: string,
  embeddingModelId: string,
  options: ProbeEndpointOptions,
): Promise<EmbeddingDimensionProbeResult | null> {
  const cleanBase = baseUrl.trim().replace(/\/+$/u, '');
  const timed = createTimedSignal(EMBEDDINGS_TIMEOUT_MS, options.signal);

  try {
    if (preset.providerType === 'gemini') {
      const geminiBase = /\/v1(?:beta)?$/u.test(cleanBase) ? cleanBase : `${cleanBase}/v1beta`;
      const response = await executeFetch(
        `${geminiBase}/models/${encodeURIComponent(embeddingModelId)}:embedContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'x-goog-api-key': apiKey } : {}),
          },
          body: JSON.stringify({
            content: {
              parts: [{ text: 'ping' }],
            },
          }),
          signal: timed.signal,
        },
        options.fetcher,
      );

      if (!response.ok) return null;
      const json = (await response.json()) as { embedding?: { values?: unknown } };
      const values = json?.embedding?.values;
      if (
        Array.isArray(values) &&
        values.length >= MIN_EMBEDDING_DIMENSION &&
        values.length <= MAX_EMBEDDING_DIMENSION
      ) {
        return { embeddingModelId, dimension: values.length };
      }
      return null;
    }

    if (preset.providerType === 'anthropic') {
      return null;
    }

    const embeddingsUrl = buildOpenAiEmbeddingsUrl(cleanBase);
    const response = await executeFetch(
      embeddingsUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: embeddingModelId,
          input: 'ping',
          encoding_format: 'float',
        }),
        signal: timed.signal,
      },
      options.fetcher,
    );

    if (!response.ok) return null;
    const json = (await response.json()) as {
      data?: Array<{ embedding?: unknown }>;
    };
    const vec = json?.data?.[0]?.embedding;
    if (
      Array.isArray(vec) &&
      vec.length >= MIN_EMBEDDING_DIMENSION &&
      vec.length <= MAX_EMBEDDING_DIMENSION
    ) {
      return { embeddingModelId, dimension: vec.length };
    }
    return null;
  } catch {
    // Live embedding probe failure must never abort chat provisioning
    return null;
  } finally {
    timed.cleanup();
  }
}

export async function probeByokEndpoint(
  detection: KeyDetectionResult,
  options: ProbeEndpointOptions = {},
): Promise<ByokEndpointProbeResult> {
  const apiKey = detection.sanitizedApiKey;
  if (!apiKey) {
    throw new ByokProbeError('empty_key', 'API key is empty');
  }

  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

  let resolvedPreset: ByokProviderPreset;
  let resolvedBaseUrl: string;
  let catalog: DiscoveredCatalog;

  if (detection.isAmbiguous && !detection.usedCustomBaseUrl) {
    const raced = await raceAmbiguousSkCandidates(detection.candidates, apiKey, options);
    resolvedPreset = raced.preset;
    resolvedBaseUrl = raced.preset.baseUrl;
    catalog = raced.catalog;
  } else {
    const targetPreset = detection.preset ?? BYOK_PRESETS.siliconflow;
    resolvedPreset = targetPreset;
    resolvedBaseUrl = detection.effectiveBaseUrl || targetPreset.baseUrl;
    catalog = await fetchCatalogForPreset(
      targetPreset,
      resolvedBaseUrl,
      apiKey,
      MODELS_TIMEOUT_MS,
      options,
    );
  }

  if (catalog.chatModels.length === 0) {
    throw new ByokProbeError('no_models', 'No chat models returned');
  }

  const rankedEmbeddings = rankEmbeddingCandidates(catalog.embeddingCandidates);
  let embeddingResult: EmbeddingDimensionProbeResult | null = null;
  let chatOnlyReason: 'no_embedding_endpoint' | 'provider_chat_only' | undefined;

  if (resolvedPreset.providerType === 'anthropic') {
    chatOnlyReason = 'provider_chat_only';
  } else if (rankedEmbeddings.length > 0) {
    const candidatesToTry = rankedEmbeddings.slice(0, 2);
    for (const candidate of candidatesToTry) {
      embeddingResult = await probeSingleEmbeddingDimension(
        resolvedPreset,
        resolvedBaseUrl,
        apiKey,
        candidate.id,
        options,
      );
      if (embeddingResult) break;
    }
    if (!embeddingResult) {
      chatOnlyReason = 'no_embedding_endpoint';
    }
  } else if (
    resolvedPreset.providerType === 'openai-compatible' &&
    (resolvedPreset.id === 'custom' || detection.usedCustomBaseUrl)
  ) {
    embeddingResult = await probeSingleEmbeddingDimension(
      resolvedPreset,
      resolvedBaseUrl,
      apiKey,
      'text-embedding-3-small',
      options,
    );
    if (!embeddingResult) {
      chatOnlyReason = 'no_embedding_endpoint';
    }
  } else {
    chatOnlyReason = resolvedPreset.supportsEmbeddingsByDefault
      ? 'no_embedding_endpoint'
      : 'provider_chat_only';
  }

  const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const latencyMs = Math.max(1, Math.round(finishedAt - startedAt));

  return {
    resolvedPreset,
    resolvedBaseUrl,
    chatModels: catalog.chatModels,
    embeddingCandidates: rankedEmbeddings,
    rerankCandidates: catalog.rerankCandidates,
    embeddingResult,
    chatOnlyReason,
    latencyMs,
  };
}
