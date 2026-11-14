import { invoke } from '@tauri-apps/api/core';
import { dispatchTypedEvent } from '@/events';
import type { ModelAssignments, ModelProfile, VendorConfig } from '@/types';
import { inferApiCapabilities } from '@/utils/apiCapabilityEngine';
import {
  applyProviderSpecificAdjustments,
  getModelDefaultParameters,
  inferCapabilities,
} from '@/utils/modelCapabilities';
import {
  defaultApiProtocolForProvider,
  normalizeBaseUrl,
} from './providerConfig';
import type {
  ByokEndpointProbeResult,
  ByokProviderPreset,
  ByokSlotAssignment,
  ProbedModelDescriptor,
  SlotProvisionResult,
} from './types';

const DEFAULT_MODEL_ASSIGNMENTS: ModelAssignments = {
  model2_config_id: null,
  anki_card_model_config_id: null,
  qbank_ai_grading_model_config_id: null,
  qbank_ai_generation_model_config_id: null,
  embedding_model_config_id: null,
  reranker_model_config_id: null,
  chat_title_model_config_id: null,
  exam_sheet_ocr_model_config_id: null,
  translation_model_config_id: null,
  vl_embedding_model_config_id: null,
  vl_reranker_model_config_id: null,
  memory_decision_model_config_id: null,
  review_analysis_model_config_id: null,
  voice_input_asr_model_config_id: null,
  image_generation_model_config_id: null,
  compaction_model_config_id: null,
  translation_display_mode: null,
};

// ConfigAPI logs raw IPC errors, which may echo credential-bearing payloads.
// The provisioner deliberately exposes only a stable credential-free failure.
async function withConfigGuard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error('BYOK configuration operation failed');
  }
}

const PRIMARY_CHAT_PRIORITY: readonly RegExp[] = [
  /claude-(?:sonnet-5|opus-5|sonnet-4)/i,
  /gpt-5(?:\.\d+)?(?![-\w]*mini|[-\w]*nano|[-\w]*codex)/i,
  /gpt-4\.1(?![-\w]*mini|[-\w]*nano)/i,
  /gpt-4o(?![-\w]*mini)/i,
  /gemini-(?:3(?:\.\d+)?|2\.5)-pro/i,
  /deepseek-(?:v4|flash|v3|chat)/i,
  /qwen3(?:\.\d+)?-(?:235b|max)|^qwen-max/i,
  /glm-(?:5(?:\.\d+)?|4\.[567])(?![-\w]*flash)/i,
  /kimi-k(?:3|2\.[56])/i,
  /grok-(?:4|3)(?![-\w]*mini)/i,
  /claude-3-[57]-sonnet/i,
  /gemini-(?:3(?:\.\d+)?|2\.5)-flash/i,
];

const FAST_UTILITY_PRIORITY: readonly RegExp[] = [
  /gpt-5(?:\.\d+)?-(?:mini|nano)/i,
  /gpt-4\.1-(?:mini|nano)|gpt-4o-mini/i,
  /claude-(?:haiku-4|3-5-haiku|3-haiku)/i,
  /gemini-(?:3(?:\.\d+)?|2\.5)-flash(?![-\w]*thinking)/i,
  /qwen(?:3|2\.5)-(?:7b|8b|14b|30b)|qwen3?(?:\.\d+)?-flash|ling-mini/i,
  /glm-4(?:\.\d+)?-flash/i,
  /deepseek-(?:v4-flash|flash|chat)/i,
  /grok-3-mini|llama-3\.[13]-8b/i,
];

const CODING_AGENT_PRIORITY: readonly RegExp[] = [
  /claude-(?:sonnet-5|sonnet-4|3-[57]-sonnet)/i,
  /qwen(?:3|2\.5)-coder/i,
  /deepseek-(?:v4|v3|chat|coder)/i,
  /gpt-5(?:\.\d+)?|gpt-4\.1(?![-\w]*nano)/i,
  /kimi-k2\.7-code|kimi-k3/i,
  /gemini-(?:3(?:\.\d+)?|2\.5)-pro/i,
];

const VISION_PARSE_PRIORITY: readonly RegExp[] = [
  /gpt-5(?:\.\d+)?|gpt-4o|gpt-4\.1/i,
  /claude-(?:sonnet-5|sonnet-4|3-[57]-sonnet)/i,
  /gemini-(?:3(?:\.\d+)?|2\.5)-(?:pro|flash)/i,
  /qwen(?:3|2\.5)-vl-(?:72b|32b|8b|7b|max|plus)|qwen3(?:\.\d+)?-plus/i,
  /glm-4(?:\.\d+)?v/i,
  /kimi-k(?:3|2\.[56])/i,
];

const DOCUMENT_OCR_PRIORITY: readonly RegExp[] = [
  /paddleocr-vl-1\.5|paddleocr-vl/i,
  /deepseek-ocr/i,
  /qwen(?:3|2\.5)-vl/i,
  /gemini-(?:3(?:\.\d+)?|2\.5)-flash/i,
  /gpt-4o-mini|gpt-4o/i,
];

const RERANKER_PRIORITY: readonly RegExp[] = [
  /bge-reranker-v2-m3/i,
  /qwen3-reranker-8b|qwen3-reranker/i,
  /gte-rerank/i,
  /jina-reranker/i,
  /rerank/i,
];

function generateProfileId(prefix = 'byok'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function pickBestByPatterns<T extends { id: string }>(
  items: readonly T[],
  patterns: readonly RegExp[],
): T | null {
  if (items.length === 0) return null;
  for (const pattern of patterns) {
    const found = items.find((item) => pattern.test(item.id));
    if (found) return found;
  }
  return null;
}

function isVisionCapableDescriptor(
  descriptor: ProbedModelDescriptor,
  vendorProviderType: string,
  baseUrl: string,
): boolean {
  if (
    baseUrl.toLowerCase().includes('siliconflow') &&
    descriptor.id.toLowerCase().includes('glm-4.6v')
  ) {
    return false;
  }
  const caps = inferCapabilities({
    id: descriptor.id,
    name: descriptor.label,
    providerScope: vendorProviderType,
  });
  const extCaps = inferApiCapabilities({
    id: descriptor.id,
    name: descriptor.label,
    providerScope: vendorProviderType,
  });
  return Boolean(caps.isMultimodal || extCaps.vision);
}

function resolveContextWindow(
  descriptor: ProbedModelDescriptor,
  vendorProviderType: string,
): number {
  if (descriptor.contextWindow && descriptor.contextWindow > 0) {
    return descriptor.contextWindow;
  }
  const ext = inferApiCapabilities({
    id: descriptor.id,
    name: descriptor.label,
    providerScope: vendorProviderType,
  });
  return ext.contextWindow;
}

function buildModelProfileForDescriptor(
  vendor: VendorConfig,
  descriptor: ProbedModelDescriptor,
  roleHint: 'chat' | 'embedding' | 'reranker',
  existingProfile?: ModelProfile,
): ModelProfile {
  const modelId = descriptor.id;
  const label = descriptor.label || modelId;
  const caps = inferCapabilities({
    id: modelId,
    name: label,
    providerScope: vendor.providerType,
  });
  const extCaps = inferApiCapabilities({
    id: modelId,
    name: label,
    providerScope: vendor.providerType,
  });
  const defaults = getModelDefaultParameters(modelId, {
    providerScope: vendor.providerType,
  });

  const vendorProviderTypeLower = (vendor.providerType ?? '').toLowerCase();
  const isGoogleVendor =
    vendorProviderTypeLower === 'gemini' || vendorProviderTypeLower === 'google';
  const isNvidiaVendor = vendorProviderTypeLower === 'nvidia';
  const modelAdapter = isGoogleVendor
    ? 'google'
    : vendorProviderTypeLower === 'anthropic'
      ? 'anthropic'
      : caps.modelAdapter;

  const isEmbedding = roleHint === 'embedding' ? true : caps.isEmbedding && roleHint !== 'chat';
  const isReranker = roleHint === 'reranker' ? true : caps.isReranker && roleHint !== 'chat';

  const effectiveSupportsReasoning =
    !isEmbedding &&
    !isReranker &&
    (caps.supportsReasoning ||
      extCaps.reasoning ||
      extCaps.supportsReasoningEffort ||
      extCaps.supportsThinkingTokens ||
      extCaps.supportsHybridReasoning);

  const enableThinkingDefault =
    effectiveSupportsReasoning && !isNvidiaVendor
      ? (defaults.enableThinking ??
        (extCaps.supportsThinkingTokens || extCaps.supportsHybridReasoning || caps.isReasoning))
      : false;

  const profile: ModelProfile = {
    ...(existingProfile ?? {}),
    id: existingProfile?.id || generateProfileId('vm'),
    vendorId: vendor.id,
    label: existingProfile?.label || label,
    model: modelId,
    providerScope: vendor.providerType,
    apiProtocol: vendor.apiProtocol,
    modelAdapter,
    status: 'enabled',
    enabled: true,
    isMultimodal: !isEmbedding && !isReranker && Boolean(caps.isMultimodal || extCaps.vision),
    isReasoning: effectiveSupportsReasoning,
    isEmbedding,
    isReranker,
    supportsTools: !isEmbedding && !isReranker && Boolean(caps.supportsTools || extCaps.functionCalling),
    supportsReasoning: effectiveSupportsReasoning,
    maxOutputTokens:
      descriptor.maxOutputTokens ??
      defaults.maxOutputTokens ??
      extCaps.maxOutputTokens ??
      8192,
    temperature: defaults.temperature ?? 0.7,
    thinkingEnabled: enableThinkingDefault,
    enableThinking: enableThinkingDefault,
    includeThoughts:
      effectiveSupportsReasoning && !isNvidiaVendor
        ? (defaults.includeThoughts ?? extCaps.supportsThinkingTokens)
        : false,
    thinkingBudget:
      effectiveSupportsReasoning && !isNvidiaVendor ? defaults.thinkingBudget : undefined,
    reasoningEffort: effectiveSupportsReasoning ? defaults.reasoningEffort : undefined,
    minP: defaults.minP,
    topK: defaults.topK,
    contextWindow: descriptor.contextWindow ?? extCaps.contextWindow,
    geminiApiVersion: isGoogleVendor ? 'v1beta' : undefined,
    isBuiltin: existingProfile?.isBuiltin ?? false,
  };

  if (!isEmbedding && !isReranker) {
    const adjustments = applyProviderSpecificAdjustments({
      modelId,
      supportsTools: profile.supportsTools ?? false,
      supportsReasoning: caps.supportsReasoning,
    });
    if (adjustments.enableThinking !== undefined) {
      profile.enableThinking = adjustments.enableThinking;
      profile.thinkingEnabled = adjustments.enableThinking;
    }
    if (adjustments.includeThoughts !== undefined) {
      profile.includeThoughts = adjustments.includeThoughts;
    }
    if (adjustments.thinkingBudget !== undefined) {
      profile.thinkingBudget = adjustments.thinkingBudget;
    }
  }

  return profile;
}

function resolveOrCreateVendor(
  existingVendors: readonly VendorConfig[],
  preset: ByokProviderPreset,
  baseUrl: string,
  apiKey: string,
  storedKeys: ReadonlyMap<string, string>,
): { vendor: VendorConfig; nextVendors: VendorConfig[]; isBuiltinKey: boolean } {
  const normalizedTargetUrl = normalizeBaseUrl(baseUrl);
  // Adding another account/gateway must not rewrite existing models' credentials
  // or silently redirect a customized builtin endpoint.
  const matched = existingVendors.find((item) => {
    const existingKey = storedKeys.get(item.id) || item.apiKey;
    return item.authMode !== 'openai_codex_oauth' &&
      normalizeBaseUrl(item.baseUrl || '') === normalizedTargetUrl &&
      (item.providerType === preset.vendorProviderType || preset.id === 'custom') &&
      (!existingKey || existingKey === apiKey);
  });

  const apiProtocol = defaultApiProtocolForProvider(preset.vendorProviderType, {
    baseUrl,
  });

  if (matched) {
    const isBuiltin = Boolean(matched.isBuiltin || matched.id.startsWith('builtin-'));
    const updatedVendor: VendorConfig = {
      ...matched,
      baseUrl: baseUrl || matched.baseUrl,
      apiKey,
      apiKeys: matched.apiKeys ?? [],
      headers: matched.headers ?? {},
      apiProtocol: matched.apiProtocol ?? apiProtocol,
    };
    const nextVendors = existingVendors.map((item) =>
      item.id === matched.id ? updatedVendor : { ...item, apiKeys: item.apiKeys ?? [], headers: item.headers ?? {} },
    );
    return { vendor: updatedVendor, nextVendors, isBuiltinKey: isBuiltin };
  }

  const vendorId = preset.builtinVendorId && !existingVendors.some((item) => item.id === preset.builtinVendorId)
    ? preset.builtinVendorId : generateProfileId('vendor');
  const isBuiltin = Boolean(vendorId.startsWith('builtin-'));
  const createdVendor: VendorConfig = {
    id: vendorId,
    name: preset.displayName,
    providerType: preset.vendorProviderType,
    authMode: 'api_key',
    apiProtocol,
    supportsOpenAIResponses: apiProtocol === 'openai_responses',
    baseUrl,
    apiKey,
    apiKeys: [],
    headers: {},
    isBuiltin,
    isReadOnly: false,
    sortOrder: existingVendors.length,
  };

  const normalizedExisting = existingVendors.map((item) => ({
    ...item,
    apiKeys: item.apiKeys ?? [],
    headers: item.headers ?? {},
  }));
  return {
    vendor: createdVendor,
    nextVendors: [...normalizedExisting, createdVendor],
    isBuiltinKey: isBuiltin,
  };
}

function dispatchConfigRefreshEvents(
  vendors: VendorConfig[],
  modelProfiles: ModelProfile[],
): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
    return;
  }
  try {
    dispatchTypedEvent('api_configurations_changed', { vendors, modelProfiles });
    dispatchTypedEvent('model_assignments_changed');
  } catch {
    // Ignore in non-DOM test environments
  }
}

export async function provisionByokSlots(
  probeResult: ByokEndpointProbeResult,
  sanitizedApiKey: string,
): Promise<SlotProvisionResult> {
  if (probeResult.chatModels.length === 0) throw new Error('No chat models available');
  const [existingVendorsRaw, existingProfilesRaw, existingAssignmentsRaw] = await Promise.all([
    withConfigGuard(() => invoke<VendorConfig[]>('get_vendor_configs')),
    withConfigGuard(() => invoke<ModelProfile[]>('get_model_profiles')),
    withConfigGuard(() => invoke<ModelAssignments | null>('get_model_assignments')),
  ]);

  if (!Array.isArray(existingVendorsRaw) || !Array.isArray(existingProfilesRaw)) {
    throw new Error('Invalid BYOK configuration response');
  }
  const existingVendors = existingVendorsRaw.map((vendor) => ({ ...vendor }));
  const storedKeys = new Map<string, string>();
  for (const vendor of existingVendors) {
    if (vendor.isBuiltin || vendor.id.startsWith('builtin-')) {
      const storedKey = await withConfigGuard(() =>
        invoke<string | null>('get_setting', { key: `${vendor.id}.api_key` }),
      );
      if (storedKey) storedKeys.set(vendor.id, storedKey);
    }
  }
  const existingProfiles = Array.isArray(existingProfilesRaw) ? existingProfilesRaw : [];
  const currentAssignments: ModelAssignments = {
    ...DEFAULT_MODEL_ASSIGNMENTS,
    ...(existingAssignmentsRaw && typeof existingAssignmentsRaw === 'object'
      ? (existingAssignmentsRaw as Partial<ModelAssignments>)
      : {}),
  };

  const { vendor, nextVendors, isBuiltinKey } = resolveOrCreateVendor(
    existingVendors,
    probeResult.resolvedPreset,
    probeResult.resolvedBaseUrl,
    sanitizedApiKey,
    storedKeys,
  );

  // Persist builtin vendor key via secure setting key AND persist vendor configs
  if (isBuiltinKey) {
    await withConfigGuard(() =>
      invoke('save_setting', { key: `${vendor.id}.api_key`, value: sanitizedApiKey }),
    );
  }
  await withConfigGuard(() => invoke('save_vendor_configs', { configs: nextVendors }));

  // Select winning models for the 8 Core Functional Slots
  const chatPool = probeResult.chatModels;
  const primaryWinner =
    pickBestByPatterns(chatPool, PRIMARY_CHAT_PRIORITY) ?? chatPool[0];
  const fastWinner =
    pickBestByPatterns(chatPool, FAST_UTILITY_PRIORITY) ?? primaryWinner;

  const fastContextWindow = resolveContextWindow(fastWinner, vendor.providerType);
  const summaryWinner = fastContextWindow >= 64_000 ? fastWinner : primaryWinner;

  const codingWinner =
    pickBestByPatterns(chatPool, CODING_AGENT_PRIORITY) ?? primaryWinner;

  const visionCandidates = chatPool.filter((model) =>
    isVisionCapableDescriptor(model, vendor.providerType, vendor.baseUrl),
  );
  const visionWinner =
    pickBestByPatterns(visionCandidates, VISION_PARSE_PRIORITY) ??
    visionCandidates[0] ??
    null;

  const ocrWinner =
    pickBestByPatterns(visionCandidates, DOCUMENT_OCR_PRIORITY) ?? visionWinner;

  const embeddingWinner: ProbedModelDescriptor | null = probeResult.embeddingResult
    ? (probeResult.embeddingCandidates.find(
        (item) => item.id === probeResult.embeddingResult!.embeddingModelId,
      ) ?? {
        id: probeResult.embeddingResult.embeddingModelId,
        label: probeResult.embeddingResult.embeddingModelId,
      })
    : null;

  const rerankWinner =
    pickBestByPatterns(probeResult.rerankCandidates, RERANKER_PRIORITY) ??
    probeResult.rerankCandidates[0] ??
    null;

  // Materialize distinct ModelProfiles for winning models (never polluting with 200 unused rows)
  const nextProfiles = [...existingProfiles];
  const provisionedByModelKey = new Map<string, ModelProfile>();

  const ensureWinnerProfile = (
    descriptor: ProbedModelDescriptor | null,
    roleHint: 'chat' | 'embedding' | 'reranker',
  ): ModelProfile | null => {
    if (!descriptor) return null;
    const normalizedId = descriptor.id.trim().toLowerCase();
    const cached = provisionedByModelKey.get(`${roleHint}:${normalizedId}`);
    if (cached) return cached;

    const existingIdx = nextProfiles.findIndex(
      (item) =>
        item.vendorId === vendor.id && item.model.trim().toLowerCase() === normalizedId &&
        item.enabled !== false && item.status !== 'disabled',
    );
    const existingProfile = existingIdx >= 0 ? nextProfiles[existingIdx] : undefined;
    const built = existingProfile ?? buildModelProfileForDescriptor(vendor, descriptor, roleHint);

    if (existingIdx >= 0) {
      nextProfiles[existingIdx] = built;
    } else {
      nextProfiles.push(built);
    }
    provisionedByModelKey.set(`${roleHint}:${normalizedId}`, built);
    return built;
  };

  const primaryProfile = ensureWinnerProfile(primaryWinner, 'chat')!;
  const fastProfile = ensureWinnerProfile(fastWinner, 'chat')!;
  const summaryProfile = ensureWinnerProfile(summaryWinner, 'chat')!;
  const codingProfile = ensureWinnerProfile(codingWinner, 'chat')!;
  const visionProfile = ensureWinnerProfile(visionWinner, 'chat');
  const ocrProfile = ensureWinnerProfile(ocrWinner, 'chat');
  const embeddingProfile = ensureWinnerProfile(embeddingWinner, 'embedding');
  const rerankProfile = ensureWinnerProfile(rerankWinner, 'reranker');

  await withConfigGuard(() => invoke('save_model_profiles', { profiles: nextProfiles }));

  // Register OCR engine when a vision/OCR model was provisioned
  if (ocrProfile) {
    try {
      await invoke('add_ocr_engine', {
        configId: ocrProfile.id,
        model: ocrProfile.model,
        name: ocrProfile.label || ocrProfile.model,
      });
    } catch {
      // Optional IPC command in non-Tauri or already-registered environments
    }
  }

  const isEmptySlot = (val: string | null | undefined): boolean =>
    !val || val.trim() === '' || val === '__system_ocr__';

  const nextAssignments: ModelAssignments = { ...currentAssignments };

  // Slot 1: Primary Chat -> model2_config_id (+ review_analysis_model_config_id if empty)
  nextAssignments.model2_config_id = primaryProfile.id;
  if (isEmptySlot(nextAssignments.review_analysis_model_config_id)) {
    nextAssignments.review_analysis_model_config_id = primaryProfile.id;
  }

  // Slot 2: Fast Utility -> chat_title_model_config_id (+ translation & anki if empty)
  nextAssignments.chat_title_model_config_id = fastProfile.id;
  if (isEmptySlot(nextAssignments.translation_model_config_id)) {
    nextAssignments.translation_model_config_id = fastProfile.id;
  }
  if (isEmptySlot(nextAssignments.anki_card_model_config_id)) {
    nextAssignments.anki_card_model_config_id = fastProfile.id;
  }

  // Slot 3: Summary & Memory -> memory_decision_model_config_id (+ compaction_model_config_id)
  nextAssignments.memory_decision_model_config_id = summaryProfile.id;
  if (isEmptySlot(nextAssignments.compaction_model_config_id)) {
    nextAssignments.compaction_model_config_id = summaryProfile.id;
  }

  // Slot 4: Coding & Agent Generation -> qbank_ai_generation_model_config_id
  nextAssignments.qbank_ai_generation_model_config_id = codingProfile.id;

  // Slot 5: Vision & Exam Parse -> qbank_ai_grading_model_config_id
  let visionPreserved = false;
  if (visionProfile) {
    nextAssignments.qbank_ai_grading_model_config_id = visionProfile.id;
  } else if (!isEmptySlot(currentAssignments.qbank_ai_grading_model_config_id)) {
    visionPreserved = true;
  } else {
    // Text-only fallback for grading while keeping vision slot report accurate
    nextAssignments.qbank_ai_grading_model_config_id = primaryProfile.id;
  }

  // Slot 6: Document OCR -> exam_sheet_ocr_model_config_id (vision/OCR only!)
  let ocrPreserved = false;
  if (ocrProfile) {
    nextAssignments.exam_sheet_ocr_model_config_id = ocrProfile.id;
  } else if (!isEmptySlot(currentAssignments.exam_sheet_ocr_model_config_id)) {
    ocrPreserved = true;
  }

  // Slot 7: Text Embedding -> embedding_model_config_id
  // CRITICAL: Only set when live embeddings probe succeeded with dimension > 0;
  // NEVER overwrite a pre-existing working embedding_model_config_id when chat-only!
  let embeddingPreserved = false;
  if (embeddingProfile && probeResult.embeddingResult && probeResult.embeddingResult.dimension > 0) {
    nextAssignments.embedding_model_config_id = embeddingProfile.id;
  } else if (!isEmptySlot(currentAssignments.embedding_model_config_id)) {
    embeddingPreserved = true;
  }

  // Slot 8: RAG Reranker -> reranker_model_config_id
  let rerankPreserved = false;
  if (rerankProfile) {
    nextAssignments.reranker_model_config_id = rerankProfile.id;
  } else if (!isEmptySlot(currentAssignments.reranker_model_config_id)) {
    rerankPreserved = true;
  }

  const slots: ByokSlotAssignment[] = [
    {
      slotNumber: 1,
      roleId: 'primary_chat',
      primaryAssignmentKey: 'model2_config_id',
      secondaryAssignmentKeys: ['review_analysis_model_config_id'],
      configId: primaryProfile.id,
      modelId: primaryProfile.model,
      modelLabel: primaryProfile.label,
      preservedExisting: false,
    },
    {
      slotNumber: 2,
      roleId: 'fast_utility',
      primaryAssignmentKey: 'chat_title_model_config_id',
      secondaryAssignmentKeys: ['translation_model_config_id', 'anki_card_model_config_id'],
      configId: fastProfile.id,
      modelId: fastProfile.model,
      modelLabel: fastProfile.label,
      preservedExisting: false,
    },
    {
      slotNumber: 3,
      roleId: 'summary_memory',
      primaryAssignmentKey: 'memory_decision_model_config_id',
      secondaryAssignmentKeys: ['compaction_model_config_id'],
      configId: summaryProfile.id,
      modelId: summaryProfile.model,
      modelLabel: summaryProfile.label,
      preservedExisting: false,
    },
    {
      slotNumber: 4,
      roleId: 'coding_agent',
      primaryAssignmentKey: 'qbank_ai_generation_model_config_id',
      secondaryAssignmentKeys: [],
      configId: codingProfile.id,
      modelId: codingProfile.model,
      modelLabel: codingProfile.label,
      preservedExisting: false,
    },
    {
      slotNumber: 5,
      roleId: 'vision_parse',
      primaryAssignmentKey: 'qbank_ai_grading_model_config_id',
      secondaryAssignmentKeys: [],
      configId: visionProfile?.id ?? (visionPreserved ? nextAssignments.qbank_ai_grading_model_config_id : null),
      modelId: visionProfile?.model ?? null,
      modelLabel: visionProfile?.label ?? null,
      preservedExisting: visionPreserved,
    },
    {
      slotNumber: 6,
      roleId: 'document_ocr',
      primaryAssignmentKey: 'exam_sheet_ocr_model_config_id',
      secondaryAssignmentKeys: [],
      configId: ocrProfile?.id ?? (ocrPreserved ? nextAssignments.exam_sheet_ocr_model_config_id : null),
      modelId: ocrProfile?.model ?? null,
      modelLabel: ocrProfile?.label ?? null,
      preservedExisting: ocrPreserved,
    },
    {
      slotNumber: 7,
      roleId: 'text_embedding',
      primaryAssignmentKey: 'embedding_model_config_id',
      secondaryAssignmentKeys: [],
      configId:
        embeddingProfile?.id ??
        (embeddingPreserved ? nextAssignments.embedding_model_config_id : null),
      modelId: embeddingProfile?.model ?? null,
      modelLabel: embeddingProfile?.label ?? null,
      preservedExisting: embeddingPreserved,
    },
    {
      slotNumber: 8,
      roleId: 'rag_reranker',
      primaryAssignmentKey: 'reranker_model_config_id',
      secondaryAssignmentKeys: [],
      configId:
        rerankProfile?.id ?? (rerankPreserved ? nextAssignments.reranker_model_config_id : null),
      modelId: rerankProfile?.model ?? null,
      modelLabel: rerankProfile?.label ?? null,
      preservedExisting: rerankPreserved,
    },
  ];

  // Quick setup fills holes; explicit user assignments always win, including
  // an existing embedding model whose vector space differs from the new one.
  type ModelAssignmentKey = Exclude<keyof ModelAssignments, 'translation_display_mode'>;
  for (const key of Object.keys(currentAssignments).filter((key) => key !== 'translation_display_mode') as ModelAssignmentKey[]) {
    if (!isEmptySlot(currentAssignments[key])) nextAssignments[key] = currentAssignments[key];
  }
  for (const slot of slots) {
    const existingId = currentAssignments[slot.primaryAssignmentKey];
    if (!isEmptySlot(existingId)) {
      const profile = existingProfiles.find((item) => item.id === existingId);
      slot.configId = existingId;
      slot.modelId = profile?.model ?? null;
      slot.modelLabel = profile?.label ?? null;
      slot.preservedExisting = true;
    }
  }
  await withConfigGuard(() => invoke('save_model_assignments', { assignments: nextAssignments }));

  const assignedSlotCount = slots.filter((slot) => Boolean(slot.configId)).length;
  const distinctProfiles = Array.from(new Set(provisionedByModelKey.values()));

  dispatchConfigRefreshEvents(nextVendors, nextProfiles);

  return {
    vendor,
    enabledModelProfiles: distinctProfiles,
    assignments: nextAssignments,
    slots,
    assignedSlotCount,
    embeddingConfigId: embeddingProfile?.id ?? null,
    embeddingModelId: embeddingProfile?.model ?? null,
  };
}
