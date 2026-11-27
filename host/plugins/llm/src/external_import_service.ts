/**
 * 外部工具模型配置扫描、探测与增量合并落库服务（L02-llm-manager）。
 *
 * - 扫描会话仅在进程内存中短期缓存解密态候选密钥（15 分钟 TTL，最多 8 个会话），
 *   IPC 返回给前端的始终是脱敏掩码（如 `sk-••••9f2a`）；
 * - 支持增量重同步：通过 `external_llm_import_provenance` 设置项与端点/协议匹配识别已有供应商，
 *   合并新增模型与轮换密钥，绝不重复创建相同供应商；
 * - 支持空缺槽位智能补齐：严格保留用户已配置的槽位（尤其是不覆盖现有 `embedding_model_config_id`）。
 */
const randomUUID = () => globalThis.crypto.randomUUID();
import { AppError } from '../../../platform/errors/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { ExternalLlmConfigsService } from '../../../platform/storage/api.ts';
import type {
  ExternalCandidateModelDto,
  ExternalLlmImportResult,
  ExternalLlmScanReport,
  ExternalVendorCandidateDto,
  ExternalVendorImportSelection,
  FetchedVendorModel,
} from '../../../../contracts/ipc/generated/L02-llm-manager.ts';
import type { ModelAssignments, ModelProfile, VendorConfig } from '../api.ts';
import { looksLikeImageGenerationModelId, resolveCapabilityOverrides } from './capabilities.ts';
import type { LlmConfigStore } from './config_store.ts';
import { defaultVendorConfig } from './config_values.ts';
import {
  maskExternalApiKey,
  parseAndNormalizeExternalSources,
  type ExternalSourceTag,
  type ParsedExternalModel,
  type ParsedExternalVendor,
  type RawExternalInputSource,
} from './external_import_parser.ts';
import {
  AUTH_MODE_NONE,
  baseUrlHost,
  effectiveApiProtocolForConfig,
} from './protocol.ts';
import { MODEL_ASSIGNMENTS_CHANGED_EVENT, MODEL_PROFILES_CHANGED_EVENT } from './settings_models_arguments.ts';
import { fetchVendorModels, type VendorModelsFetch } from './vendor_models.ts';

const PROVENANCE_SETTING_KEY = 'external_llm_import_provenance';
const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 8;

interface ProvenanceRecord {
  externalKey: string;
  sources: string[];
  lastSyncedAt: number;
}

type ProvenanceMap = Record<string, ProvenanceRecord>;

interface SessionCandidateState {
  candidateId: string;
  vendor: ParsedExternalVendor;
  matchedVendorId: string | null;
  matchedVendorName: string | null;
  syncStatus: 'new' | 'match_builtin' | 'update' | 'synced';
  models: ExternalCandidateModelDto[];
}

interface ScanSession {
  sessionId: string;
  createdAt: number;
  candidates: Map<string, SessionCandidateState>;
}

const PRIMARY_CHAT_PATTERNS: readonly RegExp[] = [
  /claude-(?:sonnet-5|opus-5|sonnet-4|opus-4)/i,
  /gpt-5(?:\.\d+)?(?![-\w]*mini|[-\w]*nano)/i,
  /deepseek-(?:v4|flash|v3|chat|reasoner)/i,
  /gemini-(?:3(?:\.\d+)?|2\.5)-pro/i,
  /qwen3(?:\.\d+)?-(?:235b|max|plus)|^qwen-max/i,
  /glm-(?:5(?:\.\d+)?|4\.[567])(?![-\w]*flash)/i,
  /kimi-k(?:3|2\.[567])/i,
  /minimax-m(?:3|2\.[57])/i,
  /doubao-seed-2/i,
  /grok-(?:4|3)(?![-\w]*mini)/i,
  /claude-3-[57]-sonnet/i,
  /gpt-4\.1(?![-\w]*mini|[-\w]*nano)|gpt-4o(?![-\w]*mini)/i,
];

const FAST_UTILITY_PATTERNS: readonly RegExp[] = [
  /claude-(?:haiku-4|3-5-haiku|3-haiku)/i,
  /gpt-5(?:\.\d+)?-(?:mini|nano)|gpt-4\.1-(?:mini|nano)|gpt-4o-mini/i,
  /gemini-(?:3(?:\.\d+)?|2\.5)-flash/i,
  /deepseek-(?:v4(?:\.1)?-flash|flash|chat)/i,
  /qwen3(?:\.\d+)?-flash|qwen(?:3|2\.5)-(?:7b|8b|14b|32b)/i,
  /glm-(?:5(?:\.\d+)?-flash|4(?:\.\d+)?-flash)/i,
  /grok-3-mini/i,
];

const CODING_PATTERNS: readonly RegExp[] = [
  /claude-(?:sonnet-5|sonnet-4|3-[57]-sonnet)/i,
  /kimi-k2\.7-code|qwen(?:3|2\.5)-coder/i,
  /deepseek-(?:v4|v3|coder|chat)/i,
  /gpt-5(?:\.\d+)?|gpt-4\.1/i,
];

const VISION_PATTERNS: readonly RegExp[] = [
  /gpt-5(?:\.\d+)?|gpt-4o|gpt-4\.1/i,
  /claude-(?:sonnet-5|opus-5|sonnet-4|3-[57]-sonnet)/i,
  /gemini-(?:3(?:\.\d+)?|2\.5)-(?:pro|flash)/i,
  /qwen(?:3|2\.5)-vl|qwen3(?:\.\d+)?-(?:max|plus)/i,
  /glm-(?:5|4(?:\.\d+)?v)/i,
  /kimi-k(?:3|2\.[56])/i,
];

const OCR_PATTERNS: readonly RegExp[] = [
  /paddleocr-vl/i,
  /deepseek-ocr/i,
  /qwen(?:3|2\.5)-vl/i,
  /gemini-(?:3(?:\.\d+)?|2\.5)-flash/i,
  /gpt-4o-mini|gpt-4o/i,
];

const RERANKER_PATTERNS: readonly RegExp[] = [
  /bge-reranker-v2-m3/i,
  /qwen3-reranker/i,
  /gte-rerank/i,
  /jina-reranker/i,
  /rerank/i,
];

const EMBEDDING_REGEX = /embed|bge-(?!rerank)|gte-(?!rerank)|text-embedding|jina-embeddings|m3e|bce-embedding/i;
const RERANKER_REGEX = /rerank|bge-reranker/i;
const NON_TEXT_CHAT_REGEX = /\btts\b|whisper|cosyvoice|fish-speech|sensevoice|funasr|-asr\b|suno|udio/i;

function normalizeUrlKey(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

function stripNamespacePrefix(modelId: string): string {
  const trimmed = modelId.trim();
  const slashIdx = trimmed.indexOf('/');
  return slashIdx > 0 && slashIdx < trimmed.length - 1 ? trimmed.slice(slashIdx + 1) : trimmed;
}

function isEmbeddingModelId(modelId: string): boolean {
  return EMBEDDING_REGEX.test(modelId);
}

function isRerankerModelId(modelId: string): boolean {
  return RERANKER_REGEX.test(modelId);
}

function inferModelFlags(
  modelId: string,
  providerType: string,
): {
  isMultimodal: boolean;
  isReasoning: boolean;
  isEmbedding: boolean;
  isReranker: boolean;
  isImageGeneration: boolean;
  supportsTools: boolean;
  contextWindow: number | null;
} {
  const isEmbedding = isEmbeddingModelId(modelId);
  const isReranker = !isEmbedding && isRerankerModelId(modelId);
  const isImageGeneration = !isEmbedding && !isReranker && looksLikeImageGenerationModelId(modelId);

  const directCaps = resolveCapabilityOverrides(modelId, providerType);
  const strippedId = stripNamespacePrefix(modelId);
  const fallbackCaps =
    strippedId !== modelId ? resolveCapabilityOverrides(strippedId, providerType) : directCaps;

  const lower = strippedId.toLowerCase();
  const heuristicVision =
    /(?:^|[-_/])(?:vl|vision|4o|gpt-5|claude-(?:3|4|sonnet-4|sonnet-5|opus-4|opus-5|haiku-4)|gemini-(?:2|3)|glm-4(?:\.\d+)?v|kimi-k(?:2\.[56]|3)|pixtral)/i.test(
      lower,
    );
  const heuristicReasoning =
    /(?:reasoner|thinking|\bo[134]\b|gpt-5|deepseek-r1|deepseek-v4|qwq|qwen3|claude-(?:3-7|sonnet-4|sonnet-5|opus-4|opus-5|fable)|gemini-(?:2\.5|3)|glm-(?:4\.[567]|5)|kimi-k(?:2\.[567]|3)|minimax-m(?:2\.[57]|3)|doubao-seed)/i.test(
      lower,
    );
  const heuristicTools =
    !isEmbedding &&
    !isReranker &&
    !isImageGeneration &&
    !NON_TEXT_CHAT_REGEX.test(lower) &&
    !/deepseek-ocr|paddleocr/i.test(lower);

  const isMultimodal =
    !isEmbedding &&
    !isReranker &&
    !isImageGeneration &&
    (directCaps.isMultimodal || fallbackCaps.isMultimodal || heuristicVision);
  const isReasoning =
    !isEmbedding &&
    !isReranker &&
    !isImageGeneration &&
    (directCaps.supportsReasoning || fallbackCaps.supportsReasoning || heuristicReasoning);
  const supportsTools =
    !isEmbedding &&
    !isReranker &&
    !isImageGeneration &&
    (directCaps.supportsTools || fallbackCaps.supportsTools || heuristicTools);

  return {
    isMultimodal,
    isReasoning,
    isEmbedding,
    isReranker,
    isImageGeneration,
    supportsTools,
    contextWindow: directCaps.contextWindow ?? fallbackCaps.contextWindow ?? null,
  };
}

function pickBestMatch<T extends { id: string }>(items: readonly T[], patterns: readonly RegExp[]): T | null {
  for (const pattern of patterns) {
    const matched = items.find((item) => pattern.test(item.id) || pattern.test(stripNamespacePrefix(item.id)));
    if (matched) return matched;
  }
  return null;
}

function isAuxiliaryCandidateModelId(modelId: string): boolean {
  return (
    isEmbeddingModelId(modelId) ||
    isRerankerModelId(modelId) ||
    looksLikeImageGenerationModelId(modelId) ||
    NON_TEXT_CHAT_REGEX.test(modelId)
  );
}

function selectRecommendedModelIds(models: readonly ParsedExternalModel[], providerType: string): Set<string> {
  if (models.length <= 5) {
    const eligible = models.filter(
      (m) =>
        !isEmbeddingModelId(m.id) &&
        !looksLikeImageGenerationModelId(m.id) &&
        !NON_TEXT_CHAT_REGEX.test(m.id),
    );
    return new Set((eligible.length > 0 ? eligible : models).map((m) => m.id));
  }
  const chatCandidates = models.filter(
    (m) =>
      !isEmbeddingModelId(m.id) &&
      !isRerankerModelId(m.id) &&
      !looksLikeImageGenerationModelId(m.id) &&
      !NON_TEXT_CHAT_REGEX.test(m.id),
  );
  const visionCandidates = chatCandidates.filter((m) => inferModelFlags(m.id, providerType).isMultimodal);
  const rerankCandidates = models.filter((m) => isRerankerModelId(m.id));

  const winners = new Set<string>();
  const primary = pickBestMatch(chatCandidates, PRIMARY_CHAT_PATTERNS) ?? chatCandidates[0];
  if (primary) winners.add(primary.id);
  const fast = pickBestMatch(chatCandidates, FAST_UTILITY_PATTERNS);
  if (fast) winners.add(fast.id);
  const coding = pickBestMatch(chatCandidates, CODING_PATTERNS);
  if (coding) winners.add(coding.id);
  const vision = pickBestMatch(visionCandidates, VISION_PATTERNS) ?? visionCandidates[0];
  if (vision) winners.add(vision.id);
  const ocr = pickBestMatch(visionCandidates, OCR_PATTERNS);
  if (ocr) winners.add(ocr.id);
  const rerank = pickBestMatch(rerankCandidates, RERANKER_PATTERNS) ?? rerankCandidates[0];
  if (rerank) winners.add(rerank.id);

  if (winners.size === 0 && models[0]) {
    winners.add(models[0].id);
  }
  return winners;
}

function sortCandidateModelDtos(
  items: readonly ExternalCandidateModelDto[],
  explicitLowerIds: ReadonlySet<string>,
): ExternalCandidateModelDto[] {
  return [...items].sort((left, right) => {
    const leftExplicit = explicitLowerIds.has(left.id.toLowerCase()) ? 1 : 0;
    const rightExplicit = explicitLowerIds.has(right.id.toLowerCase()) ? 1 : 0;
    if (leftExplicit !== rightExplicit) return rightExplicit - leftExplicit;
    if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
    const leftAux = isAuxiliaryCandidateModelId(left.id) ? 1 : 0;
    const rightAux = isAuxiliaryCandidateModelId(right.id) ? 1 : 0;
    if (leftAux !== rightAux) return leftAux - rightAux;
    if (left.alreadyExists !== right.alreadyExists) return left.alreadyExists ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}

function deriveOpenAiModelsFallbackUrl(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl.trim());
    let pathname = parsed.pathname.replace(/\/+$/, '');
    pathname = pathname.replace(/\/(?:api\/)?anthropic(?:\/v1)?$/i, '').replace(/\/v1$/i, '');
    parsed.pathname = `${pathname}/v1`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function readProvenanceMap(settings: SettingsStore): ProvenanceMap {
  try {
    const raw = settings.get(PROVENANCE_SETTING_KEY);
    if (!raw || !raw.trim()) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as ProvenanceMap;
  } catch {
    return {};
  }
}

function writeProvenanceMap(settings: SettingsStore, map: ProvenanceMap): void {
  try {
    settings.save(PROVENANCE_SETTING_KEY, JSON.stringify(map));
  } catch (err) {
    void err;
  }
}

function buildModelProfile(
  vendor: VendorConfig,
  descriptor: { id: string; label: string; contextWindow: number | null; maxOutputTokens: number | null },
  existingProfile?: ModelProfile,
): ModelProfile {
  const modelId = descriptor.id.trim();
  const label = descriptor.label.trim() || modelId;
  const flags = inferModelFlags(modelId, vendor.providerType);
  const protocol =
    vendor.apiProtocol ??
    effectiveApiProtocolForConfig({
      apiProtocol: null,
      providerType: vendor.providerType,
      supportsOpenaiResponses: vendor.supportsOpenaiResponses,
      modelAdapter: 'general',
      baseUrl: vendor.baseUrl,
      model: modelId,
    });

  const modelAdapter =
    protocol === 'google_generate_content'
      ? 'google'
      : protocol === 'anthropic_messages'
        ? 'anthropic'
        : vendor.providerType && vendor.providerType !== 'custom'
          ? vendor.providerType
          : 'general';

  const isNvidia = vendor.providerType.toLowerCase() === 'nvidia';
  const thinkingEnabled = flags.isReasoning && !isNvidia;

  return {
    id: existingProfile?.id ?? `ext_mp_${randomUUID()}`,
    vendorId: vendor.id,
    label: existingProfile?.label || label,
    model: modelId,
    providerScope: vendor.providerType,
    apiProtocol: protocol,
    modelAdapter: existingProfile?.modelAdapter || modelAdapter,
    status: 'enabled',
    enabled: true,
    isMultimodal: flags.isMultimodal,
    isReasoning: flags.isReasoning,
    isEmbedding: flags.isEmbedding,
    isReranker: flags.isReranker,
    isImageGeneration: flags.isImageGeneration,
    supportsTools: flags.supportsTools,
    supportsReasoning: flags.isReasoning,
    maxTokensLimit: existingProfile?.maxTokensLimit ?? null,
    maxOutputTokens: descriptor.maxOutputTokens ?? existingProfile?.maxOutputTokens ?? 8192,
    temperature: existingProfile?.temperature ?? 0.7,
    reasoningEffort: existingProfile?.reasoningEffort ?? null,
    reasoningMode: existingProfile?.reasoningMode ?? null,
    thinkingEnabled: existingProfile?.thinkingEnabled ?? thinkingEnabled,
    enableThinking: existingProfile?.enableThinking ?? thinkingEnabled,
    thinkingBudget: existingProfile?.thinkingBudget ?? null,
    includeThoughts: existingProfile?.includeThoughts ?? thinkingEnabled,
    minP: existingProfile?.minP ?? null,
    topK: existingProfile?.topK ?? null,
    geminiApiVersion: protocol === 'google_generate_content' ? 'v1beta' : (existingProfile?.geminiApiVersion ?? 'v1'),
    isBuiltin: existingProfile?.isBuiltin ?? false,
    isFavorite: existingProfile?.isFavorite ?? false,
    contextWindow: descriptor.contextWindow ?? existingProfile?.contextWindow ?? flags.contextWindow,
    repetitionPenalty: existingProfile?.repetitionPenalty ?? null,
    reasoningSplit: existingProfile?.reasoningSplit ?? null,
    effort: existingProfile?.effort ?? null,
    verbosity: existingProfile?.verbosity ?? null,
    extraBody: existingProfile?.extraBody ?? {},
  };
}

export interface ExternalLlmImportServiceDeps {
  readonly store: LlmConfigStore;
  readonly settings: SettingsStore;
  readonly externalConfigs: () => ExternalLlmConfigsService | undefined;
  readonly fetch: VendorModelsFetch;
  readonly emit: (event: string, payload: unknown) => void;
  readonly now?: () => number;
}

export class ExternalLlmImportService {
  private readonly deps: ExternalLlmImportServiceDeps;
  private readonly sessions = new Map<string, ScanSession>();

  constructor(deps: ExternalLlmImportServiceDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private pruneSessions(): void {
    const cutoff = this.now() - SESSION_TTL_MS;
    for (const [id, session] of this.sessions.entries()) {
      if (session.createdAt < cutoff) this.sessions.delete(id);
    }
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey === undefined) break;
      this.sessions.delete(oldestKey);
    }
  }

  private requireSession(sessionId: string): ScanSession {
    this.pruneSessions();
    const session = this.sessions.get(sessionId.trim());
    if (!session) {
      throw AppError.validation('导入预览会话已过期，请重新扫描或解析配置');
    }
    return session;
  }

  async scan(args: { textInput?: string | null; filePath?: string | null }): Promise<ExternalLlmScanReport> {
    const textInput = args.textInput?.trim() ?? '';
    const filePath = args.filePath?.trim() ?? '';
    const platformReader = this.deps.externalConfigs();
    const autoScanSupported = platformReader !== undefined;

    const rawInputs: RawExternalInputSource[] = [];
    if (textInput !== '') {
      rawInputs.push({
        source: 'paste',
        kind: 'auto',
        pathLabel: 'clipboard',
        text: textInput,
      });
    } else if (filePath !== '') {
      if (!platformReader) {
        throw AppError.configuration('当前运行环境不支持直接读取本地路径文件，请使用粘贴配置导入');
      }
      let fileSource;
      try {
        fileSource = await platformReader.readExternalFile(filePath);
      } catch (error) {
        throw AppError.file_system(error instanceof Error ? error.message : String(error));
      }
      rawInputs.push({
        source: fileSource.source as ExternalSourceTag,
        kind: fileSource.kind,
        pathLabel: fileSource.pathLabel,
        text: fileSource.text,
        companionText: fileSource.companionText,
        sqliteTables: fileSource.sqliteTables,
        error: fileSource.error,
      });
    } else if (platformReader) {
      const discovered = await platformReader.scanDefaultSources();
      for (const src of discovered.sources) {
        rawInputs.push({
          source: src.source as ExternalSourceTag,
          kind: src.kind,
          pathLabel: src.pathLabel,
          text: src.text,
          companionText: src.companionText,
          sqliteTables: src.sqliteTables,
          error: src.error,
        });
      }
    }

    const parsed = parseAndNormalizeExternalSources(rawInputs);
    const [runtimeVendors, existingProfiles] = await Promise.all([
      this.deps.store.vendorConfigsForRuntime(),
      this.deps.store.getModelProfiles(),
    ]);
    const provenance = readProvenanceMap(this.deps.settings);

    this.pruneSessions();
    const sessionId = `ext_scan_${randomUUID()}`;
    const candidateMap = new Map<string, SessionCandidateState>();
    const candidateDtos: ExternalVendorCandidateDto[] = [];

    for (const [index, item] of parsed.candidates.entries()) {
      const candidateId = `cand_${index + 1}`;
      const matchedVendor = this.findMatchingVendor(item, runtimeVendors, provenance);
      const existingModelsForVendor = matchedVendor
        ? new Set(
            existingProfiles
              .filter((p) => p.vendorId === matchedVendor.id && p.enabled)
              .map((p) => p.model.trim().toLowerCase()),
          )
        : new Set<string>();

      const recommendedSet = selectRecommendedModelIds(item.models, item.providerType);
      const modelDtos: ExternalCandidateModelDto[] = item.models.map((m) => ({
        id: m.id,
        label: m.label,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        alreadyExists: existingModelsForVendor.has(m.id.trim().toLowerCase()),
        recommended: recommendedSet.has(m.id),
      }));

      const syncStatus = this.computeSyncStatus(item, matchedVendor, modelDtos);
      const state: SessionCandidateState = {
        candidateId,
        vendor: item,
        matchedVendorId: matchedVendor?.id ?? null,
        matchedVendorName: matchedVendor?.name ?? null,
        syncStatus,
        models: modelDtos,
      };
      candidateMap.set(candidateId, state);

      candidateDtos.push({
        candidateId,
        name: item.name,
        providerType: item.providerType,
        apiProtocol: item.apiProtocol,
        supportsOpenaiResponses: item.supportsOpenaiResponses,
        baseUrl: item.baseUrl,
        websiteUrl: item.websiteUrl,
        maskedApiKey: maskExternalApiKey(item.apiKey),
        extraKeyCount: item.extraApiKeys.length,
        sources: item.sources,
        appTypes: item.appTypes,
        syncStatus,
        matchedVendorId: matchedVendor?.id ?? null,
        matchedVendorName: matchedVendor?.name ?? null,
        models: modelDtos,
      });
    }

    this.sessions.set(sessionId, {
      sessionId,
      createdAt: this.now(),
      candidates: candidateMap,
    });

    return {
      sessionId,
      autoScanSupported,
      sources: parsed.sourceStats,
      candidates: candidateDtos,
      skippedProxyCount: parsed.skippedProxyCount,
      skippedNoKeyCount: parsed.skippedNoKeyCount,
    };
  }

  private findMatchingVendor(
    candidate: ParsedExternalVendor,
    runtimeVendors: readonly VendorConfig[],
    provenance: ProvenanceMap,
  ): VendorConfig | null {
    if (candidate.matchedBuiltinVendorId) {
      const builtin = runtimeVendors.find((v) => v.id === candidate.matchedBuiltinVendorId);
      if (builtin) return builtin;
    }

    for (const [vendorId, record] of Object.entries(provenance)) {
      if (record.externalKey === candidate.externalKey) {
        const found = runtimeVendors.find((v) => v.id === vendorId);
        if (found && found.authMode !== 'openai_codex_oauth') return found;
      }
    }

    const targetUrl = normalizeUrlKey(candidate.baseUrl);
    for (const existing of runtimeVendors) {
      if (existing.isBuiltin || existing.id.startsWith('builtin-')) continue;
      if (existing.authMode === 'openai_codex_oauth') continue;
      if (normalizeUrlKey(existing.baseUrl) !== targetUrl) continue;
      const existingProtocol = effectiveApiProtocolForConfig({
        apiProtocol: existing.apiProtocol,
        providerType: existing.providerType,
        supportsOpenaiResponses: existing.supportsOpenaiResponses,
        modelAdapter: 'general',
        baseUrl: existing.baseUrl,
        model: '',
      });
      if (existingProtocol === candidate.apiProtocol) {
        return existing;
      }
    }
    return null;
  }

  private computeSyncStatus(
    candidate: ParsedExternalVendor,
    matchedVendor: VendorConfig | null,
    models: readonly ExternalCandidateModelDto[],
  ): 'new' | 'match_builtin' | 'update' | 'synced' {
    if (!matchedVendor) return 'new';
    const isBuiltin = matchedVendor.isBuiltin || matchedVendor.id.startsWith('builtin-');
    const existingKeys = new Set(
      [matchedVendor.apiKey, ...matchedVendor.apiKeys].map((k) => k.trim()).filter(Boolean),
    );
    const incomingKeys = [candidate.apiKey, ...candidate.extraApiKeys].map((k) => k.trim()).filter(Boolean);
    const allKeysPresent = incomingKeys.every((k) => existingKeys.has(k));
    const hasNewModels = models.some((m) => !m.alreadyExists);

    if (isBuiltin && existingKeys.size === 0) {
      return 'match_builtin';
    }
    if (allKeysPresent && !hasNewModels && (models.length > 0 || existingKeys.size > 0)) {
      return 'synced';
    }
    return isBuiltin ? 'match_builtin' : 'update';
  }

  private async fetchModelsWithRelayFallback(vendor: VendorConfig): Promise<FetchedVendorModel[]> {
    try {
      return await fetchVendorModels(vendor, { fetch: this.deps.fetch });
    } catch (primaryError) {
      // 许多第三方中转站为 Claude Code 提供 Anthropic Messages 对话接口，但仅在根路径提供
      // OpenAI 兼容的 `GET /v1/models`（Bearer 鉴权）。主探测失败时自动尝试该兜底路径。
      const isThirdPartyAnthropic =
        vendor.apiProtocol === 'anthropic_messages' &&
        baseUrlHost(vendor.baseUrl) !== 'api.anthropic.com';
      if (!isThirdPartyAnthropic) throw primaryError;
      const fallbackUrl = deriveOpenAiModelsFallbackUrl(vendor.baseUrl);
      if (!fallbackUrl) throw primaryError;
      try {
        return await fetchVendorModels(
          {
            ...vendor,
            providerType: 'custom',
            apiProtocol: 'openai_chat_completions',
            baseUrl: fallbackUrl,
          },
          { fetch: this.deps.fetch },
        );
      } catch {
        throw primaryError;
      }
    }
  }

  async probeCandidateModels(sessionId: string, candidateId: string): Promise<ExternalCandidateModelDto[]> {
    const session = this.requireSession(sessionId);
    const state = session.candidates.get(candidateId.trim());
    if (!state) {
      throw AppError.validation('未找到指定的候选供应商');
    }

    const tempVendor: VendorConfig = {
      ...defaultVendorConfig(),
      id: state.matchedVendorId ?? 'probe-temp',
      name: state.vendor.name,
      providerType: state.vendor.providerType,
      authMode: state.vendor.apiKey ? 'api_key' : AUTH_MODE_NONE,
      apiProtocol: state.vendor.apiProtocol,
      supportsOpenaiResponses: state.vendor.supportsOpenaiResponses,
      baseUrl: state.vendor.baseUrl,
      apiKey: state.vendor.apiKey,
      apiKeys: state.vendor.extraApiKeys,
      headers: state.vendor.headers,
    };

    const fetched: FetchedVendorModel[] = await this.fetchModelsWithRelayFallback(tempVendor);

    const existingProfiles = await this.deps.store.getModelProfiles();
    const existingModelsForVendor = state.matchedVendorId
      ? new Set(
          existingProfiles
            .filter((p) => p.vendorId === state.matchedVendorId && p.enabled)
            .map((p) => p.model.trim().toLowerCase()),
        )
      : new Set<string>();

    const mergedByLower = new Map<string, ParsedExternalModel>();
    for (const m of state.vendor.models) {
      mergedByLower.set(m.id.toLowerCase(), m);
    }
    for (const f of fetched) {
      const key = f.id.trim().toLowerCase();
      if (!key) continue;
      const prev = mergedByLower.get(key);
      mergedByLower.set(key, {
        id: prev?.id ?? f.id.trim(),
        label: prev?.label && prev.label !== prev.id ? prev.label : (f.label || f.id),
        contextWindow: f.contextWindow ?? prev?.contextWindow ?? null,
        maxOutputTokens: f.maxOutputTokens ?? prev?.maxOutputTokens ?? null,
      });
    }

    const allModels = [...mergedByLower.values()];
    const explicitSet = new Set(state.vendor.models.map((m) => m.id.toLowerCase()));
    const recommendedSet = selectRecommendedModelIds(allModels, state.vendor.providerType);

    const unsortedDtos: ExternalCandidateModelDto[] = allModels.map((m) => ({
      id: m.id,
      label: m.label,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      alreadyExists: existingModelsForVendor.has(m.id.toLowerCase()),
      recommended: explicitSet.has(m.id.toLowerCase()) || recommendedSet.has(m.id),
    }));
    const nextDtos = sortCandidateModelDtos(unsortedDtos, explicitSet);

    state.models = nextDtos;
    return nextDtos;
  }

  async importSelections(args: {
    sessionId: string;
    selections: readonly ExternalVendorImportSelection[];
    autoFetchMissingModels?: boolean | null;
    autoAssignEmptySlots?: boolean | null;
  }): Promise<ExternalLlmImportResult> {
    const session = this.requireSession(args.sessionId);
    if (args.selections.length === 0) {
      throw AppError.validation('请至少选择一个要导入的供应商');
    }

    const autoFetchMissing = args.autoFetchMissingModels !== false;
    const autoAssignSlots = args.autoAssignEmptySlots !== false;

    await this.deps.store.bootstrapVendorModelConfig();
    const [userVendors, runtimeVendors, existingProfiles, currentAssignments] = await Promise.all([
      this.deps.store.readUserVendorConfigs(),
      this.deps.store.vendorConfigsForRuntime(),
      this.deps.store.getModelProfiles(),
      this.deps.store.getModelAssignments(),
    ]);

    const provenance = readProvenanceMap(this.deps.settings);
    const vendorsToPersist = userVendors.map((v) => ({
      ...v,
      apiKey: v.apiKey ? '***' : '',
      apiKeys: v.apiKeys.map(() => '***'),
      headers: { ...v.headers },
    }));
    const profilesToPersist = existingProfiles.map((p) => ({ ...p }));

    let importedVendorCount = 0;
    let updatedVendorCount = 0;
    let importedModelCount = 0;
    const warnings: string[] = [];
    const touchedVendorIds: string[] = [];
    const candidateNewlyEnabledProfiles: ModelProfile[] = [];

    for (const selection of args.selections) {
      const state = session.candidates.get(selection.candidateId.trim());
      if (!state) continue;

      const item = state.vendor;
      const matchedRuntime = this.findMatchingVendor(item, runtimeVendors, provenance);
      const isBuiltin = Boolean(
        item.matchedBuiltinVendorId ||
          (matchedRuntime && (matchedRuntime.isBuiltin || matchedRuntime.id.startsWith('builtin-'))),
      );

      let targetVendor: VendorConfig;
      if (matchedRuntime) {
        const mergedKeys: string[] = [];
        for (const k of [item.apiKey, ...item.extraApiKeys, matchedRuntime.apiKey, ...matchedRuntime.apiKeys]) {
          const trimmed = k.trim();
          if (trimmed && trimmed !== '***' && !mergedKeys.includes(trimmed)) {
            mergedKeys.push(trimmed);
          }
        }
        const [primaryKey = item.apiKey, ...backupKeys] = mergedKeys;
        targetVendor = {
          ...matchedRuntime,
          name: isBuiltin ? matchedRuntime.name : item.name || matchedRuntime.name,
          baseUrl: isBuiltin ? matchedRuntime.baseUrl : item.baseUrl || matchedRuntime.baseUrl,
          apiProtocol: isBuiltin ? matchedRuntime.apiProtocol : item.apiProtocol,
          supportsOpenaiResponses: isBuiltin
            ? matchedRuntime.supportsOpenaiResponses
            : item.supportsOpenaiResponses,
          apiKey: primaryKey,
          apiKeys: isBuiltin ? [] : backupKeys,
          headers: { ...matchedRuntime.headers, ...item.headers },
          websiteUrl: matchedRuntime.websiteUrl ?? item.websiteUrl,
          isBuiltin,
        };
        const existingIdx = vendorsToPersist.findIndex((v) => v.id === targetVendor.id);
        if (existingIdx >= 0) {
          vendorsToPersist[existingIdx] = targetVendor;
        } else {
          vendorsToPersist.push(targetVendor);
        }
        updatedVendorCount += 1;
      } else {
        targetVendor = {
          ...defaultVendorConfig(),
          id: `vendor_${randomUUID()}`,
          name: item.name,
          providerType: item.providerType,
          authMode: item.apiKey ? 'api_key' : AUTH_MODE_NONE,
          apiProtocol: item.apiProtocol,
          supportsOpenaiResponses: item.supportsOpenaiResponses,
          baseUrl: item.baseUrl,
          apiKey: item.apiKey,
          apiKeys: item.extraApiKeys,
          headers: { ...item.headers },
          websiteUrl: item.websiteUrl,
          isBuiltin: false,
          isReadOnly: false,
          sortOrder: vendorsToPersist.length,
        };
        vendorsToPersist.push(targetVendor);
        importedVendorCount += 1;
      }

      touchedVendorIds.push(targetVendor.id);
      provenance[targetVendor.id] = {
        externalKey: item.externalKey,
        sources: [...item.sources],
        lastSyncedAt: this.now(),
      };

      // 解析本次需要创建/启用的模型集合
      let modelsToMaterialize: Array<{
        id: string;
        label: string;
        contextWindow: number | null;
        maxOutputTokens: number | null;
      }> = [];

      if (selection.selectedModelIds != null) {
        const selectedLower = new Set(selection.selectedModelIds.map((id) => id.trim().toLowerCase()).filter(Boolean));
        const knownByLower = new Map(state.models.map((m) => [m.id.toLowerCase(), m]));
        for (const rawId of selection.selectedModelIds) {
          const trimmed = rawId.trim();
          if (!trimmed) continue;
          const known = knownByLower.get(trimmed.toLowerCase());
          if (known) {
            modelsToMaterialize.push(known);
          } else {
            modelsToMaterialize.push({ id: trimmed, label: trimmed, contextWindow: null, maxOutputTokens: null });
          }
        }
        // 若用户在未探测的无模型供应商上保持勾选但 `selectedModelIds` 为空，按 autoFetchMissing 拉取精选模型
        if (selectedLower.size === 0 && state.models.length === 0 && autoFetchMissing) {
          modelsToMaterialize = await this.tryAutoFetchRecommendedModels(targetVendor, item.name, warnings);
        }
      } else if (state.models.length > 0) {
        const picked = state.models.filter((m) => m.recommended);
        modelsToMaterialize = picked.length > 0 ? picked : state.models.slice(0, 5);
      } else if (autoFetchMissing) {
        modelsToMaterialize = await this.tryAutoFetchRecommendedModels(targetVendor, item.name, warnings);
      }

      for (const descriptor of modelsToMaterialize) {
        const lowerId = descriptor.id.trim().toLowerCase();
        if (!lowerId) continue;
        const existingIdx = profilesToPersist.findIndex(
          (p) => p.vendorId === targetVendor.id && p.model.trim().toLowerCase() === lowerId,
        );
        const existingProfile = existingIdx >= 0 ? profilesToPersist[existingIdx] : undefined;
        const wasEnabled = Boolean(existingProfile && existingProfile.enabled);
        const nextProfile = buildModelProfile(targetVendor, descriptor, existingProfile);
        if (existingIdx >= 0) {
          profilesToPersist[existingIdx] = nextProfile;
        } else {
          profilesToPersist.push(nextProfile);
        }
        if (!wasEnabled) {
          importedModelCount += 1;
        }
        candidateNewlyEnabledProfiles.push(nextProfile);
      }
    }

    await this.deps.store.saveVendorModelConfigs(vendorsToPersist, profilesToPersist);
    writeProvenanceMap(this.deps.settings, provenance);

    let assignedSlotCount = 0;
    if (autoAssignSlots && candidateNewlyEnabledProfiles.length > 0) {
      assignedSlotCount = await this.fillEmptyAssignmentSlots(
        currentAssignments,
        candidateNewlyEnabledProfiles,
      );
    }

    try {
      this.deps.emit(MODEL_PROFILES_CHANGED_EVENT, { source: 'external_import' });
      if (assignedSlotCount > 0) {
        this.deps.emit(MODEL_ASSIGNMENTS_CHANGED_EVENT, { source: 'external_import' });
      }
    } catch (err) {
      void err;
    }

    return {
      importedVendorCount,
      updatedVendorCount,
      importedModelCount,
      assignedSlotCount,
      warnings,
      vendorIds: touchedVendorIds,
    };
  }

  private async tryAutoFetchRecommendedModels(
    vendor: VendorConfig,
    displayName: string,
    warnings: string[],
  ): Promise<ParsedExternalModel[]> {
    try {
      const fetched = await this.fetchModelsWithRelayFallback(vendor);
      const parsed: ParsedExternalModel[] = fetched.map((f) => ({
        id: f.id,
        label: f.label || f.id,
        contextWindow: f.contextWindow ?? null,
        maxOutputTokens: f.maxOutputTokens ?? null,
      }));
      const recommendedIds = selectRecommendedModelIds(parsed, vendor.providerType);
      return parsed.filter((m) => recommendedIds.has(m.id));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`${displayName}: 供应商已导入，但自动拉取模型列表未成功（${detail}）`);
      return [];
    }
  }

  private async fillEmptyAssignmentSlots(
    current: ModelAssignments,
    candidates: readonly ModelProfile[],
  ): Promise<number> {
    const isEmpty = (val: string | null | undefined): boolean =>
      !val || val.trim() === '' || val === '__system_ocr__';

    const chatPool = candidates.filter(
      (p) => p.enabled && !p.isEmbedding && !p.isReranker && !p.isImageGeneration,
    );
    const visionPool = chatPool.filter((p) => p.isMultimodal);
    const rerankPool = candidates.filter((p) => p.enabled && p.isReranker);

    const asItems = (pool: readonly ModelProfile[]) => pool.map((p) => ({ id: p.model, profile: p }));
    const primary = (pickBestMatch(asItems(chatPool), PRIMARY_CHAT_PATTERNS) ?? asItems(chatPool)[0])?.profile ?? null;
    const fast = (pickBestMatch(asItems(chatPool), FAST_UTILITY_PATTERNS)?.profile) ?? primary;
    const coding = (pickBestMatch(asItems(chatPool), CODING_PATTERNS)?.profile) ?? primary;
    const vision = (pickBestMatch(asItems(visionPool), VISION_PATTERNS) ?? asItems(visionPool)[0])?.profile ?? null;
    const ocr = (pickBestMatch(asItems(visionPool), OCR_PATTERNS)?.profile) ?? vision;
    const reranker = (pickBestMatch(asItems(rerankPool), RERANKER_PATTERNS) ?? asItems(rerankPool)[0])?.profile ?? null;

    const next: ModelAssignments = { ...current };
    let filled = 0;
    const assignIfEmpty = (
      key: Exclude<keyof ModelAssignments, 'translation_display_mode'>,
      profile: ModelProfile | null,
    ) => {
      if (!profile) return;
      if (isEmpty(next[key])) {
        next[key] = profile.id;
        filled += 1;
      }
    };

    // 严格只填补空缺槽位，且不自动覆写 `embedding_model_config_id`（避免未验证向量维度污染现有索引）
    assignIfEmpty('model2_config_id', primary);
    assignIfEmpty('review_analysis_model_config_id', primary);
    assignIfEmpty('chat_title_model_config_id', fast);
    assignIfEmpty('translation_model_config_id', fast);
    assignIfEmpty('anki_card_model_config_id', fast);
    assignIfEmpty('memory_decision_model_config_id', fast ?? primary);
    assignIfEmpty('compaction_model_config_id', fast ?? primary);
    assignIfEmpty('qbank_ai_generation_model_config_id', coding);
    assignIfEmpty('qbank_ai_grading_model_config_id', vision ?? primary);
    assignIfEmpty('exam_sheet_ocr_model_config_id', ocr);
    assignIfEmpty('reranker_model_config_id', reranker);

    if (filled > 0) {
      await this.deps.store.saveModelAssignments(next);
    }
    return filled;
  }
}
