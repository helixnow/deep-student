// 模型能力集中管理模块
// - 负责根据模型ID和（可选）supported_features 推断能力
// - 维护已知模型/系列的启发式规则与默认参数
//
// 注意：核心能力推断已统一到 apiCapabilityEngine.ts
// 本模块作为兼容层，调用 apiCapabilityEngine 并补充 supported_features 推断

import { inferApiCapabilities, type InferredApiCapabilities } from './apiCapabilityEngine';

// 子适配器类型（与后端 ADAPTER_REGISTRY 保持一致）
export type ModelAdapterType = 
  | 'general'      // 通用 OpenAI 兼容
  | 'google'       // Gemini
  | 'anthropic'    // Claude
  | 'deepseek'     // DeepSeek
  | 'qwen'         // 通义千问
  | 'zhipu'        // 智谱 GLM
  | 'doubao'       // 字节豆包
  | 'moonshot'     // Kimi/Moonshot
  | 'grok'         // xAI Grok
  | 'minimax'      // MiniMax
  | 'ernie'        // 百度文心
  | 'mistral';     // Mistral

export interface BasicModelDescriptor {
  id: string;
  supported_features?: string[];
  name?: string;
}

export interface InferredCapabilities {
  isMultimodal: boolean;
  isReasoning: boolean;
  isEmbedding: boolean;
  isReranker: boolean;
  modelAdapter: ModelAdapterType;
  supportsReasoning: boolean;
  supportsTools: boolean;
}

export interface ModelDefaultParams {
  maxOutputTokens?: number;
  enableThinking?: boolean;
  thinkingBudget?: number;
  includeThoughts?: boolean;
  temperature?: number;
  minP?: number;
  topK?: number;
}

const toLower = (s: string) => s.toLowerCase();

const featureHas = (features: string[] | undefined, ...candidates: string[]) => {
  if (!features || features.length === 0) return false;
  const lowered = features.map(toLower);
  return lowered.some((f) => candidates.some((c) => f === c || f.includes(c)));
};

/**
 * 根据模型 ID 推断子适配器类型
 * 
 * 匹配顺序很重要：更具体的模式应该在更通用的模式之前
 */
function detectAdapterById(lowerId: string): ModelAdapterType {
  // DeepSeek 系列
  if (lowerId.includes('deepseek')) return 'deepseek';
  
  // Qwen 系列（通义千问）
  if (lowerId.includes('qwen') || lowerId.includes('qwq')) return 'qwen';
  
  // GLM 系列（智谱）- 注意要在 gemini 之前检查
  if (lowerId.includes('glm') || lowerId.includes('chatglm') || lowerId.includes('zhipu')) return 'zhipu';
  
  // Gemini 系列
  if (lowerId.includes('gemini')) return 'google';
  
  // Claude 系列
  if (lowerId.includes('claude') || lowerId.includes('anthropic')) return 'anthropic';
  
  // 豆包系列（doubao 开头的所有模型，包括 doubao-seed 系列）
  if (lowerId.includes('doubao')) return 'doubao';
  
  // Kimi/Moonshot 系列
  if (lowerId.includes('kimi') || lowerId.includes('moonshot')) return 'moonshot';
  
  // Grok 系列
  if (lowerId.includes('grok')) return 'grok';
  
  // MiniMax 系列
  if (lowerId.includes('minimax') || lowerId.includes('abab')) return 'minimax';
  
  // ERNIE 系列（百度文心）
  if (lowerId.includes('ernie') || lowerId.includes('baidu')) return 'ernie';
  
  // Mistral 系列
  if (lowerId.includes('mistral') || lowerId.includes('codestral') || lowerId.includes('magistral') || lowerId.includes('devstral')) return 'mistral';
  
  // 默认使用通用适配器
  return 'general';
}

/**
 * 推断模型能力
 *
 * 统一调用 apiCapabilityEngine.ts 的能力推断，并补充 supported_features 推断。
 * 这样可以避免两个文件维护重复的模式匹配规则。
 */
export function inferCapabilities(modelLike: BasicModelDescriptor | string): InferredCapabilities {
  const modelId = typeof modelLike === 'string' ? modelLike : (modelLike?.id ?? '');
  const modelName = typeof modelLike === 'string' ? undefined : modelLike?.name;
  const supportedFeatures = (typeof modelLike === 'string' ? undefined : modelLike?.supported_features) ?? [];
  const lowerId = toLower(modelId);

  // 调用统一的 apiCapabilityEngine 进行能力推断
  const apiCaps: InferredApiCapabilities = inferApiCapabilities({ id: modelId, name: modelName });

  // 从 supported_features 补充推断（SiliconFlow API 返回的特性列表）
  const featureIsMultimodal = featureHas(supportedFeatures, 'multimodal', 'vision', 'vl', 'image');
  const featureIsReasoning = featureHas(supportedFeatures, 'reasoning', 'thinking', 'chain-of-thought', 'cot', 'reasoning-content');
  const featureIsEmbedding = featureHas(supportedFeatures, 'embedding');
  const featureIsReranker = featureHas(supportedFeatures, 'reranker');
  const featureSupportsTools = featureHas(supportedFeatures, 'tools', 'tool', 'function', 'function_call', 'tool_calls');

  // 合并：apiCapabilityEngine 的推断 OR supported_features 的声明
  const isMultimodal = apiCaps.vision || featureIsMultimodal;
  const isReasoning = apiCaps.reasoning || apiCaps.supportsThinkingTokens || apiCaps.supportsHybridReasoning || featureIsReasoning;
  const isEmbedding = apiCaps.embedding || featureIsEmbedding;
  const isReranker = apiCaps.rerank || featureIsReranker;
  const supportsTools = apiCaps.functionCalling || featureSupportsTools;
  const supportsReasoning = isReasoning || apiCaps.supportsReasoningEffort;

  const modelAdapter = detectAdapterById(lowerId);

  return {
    isMultimodal,
    isReasoning,
    isEmbedding,
    isReranker,
    modelAdapter,
    supportsReasoning,
    supportsTools,
  };
}

// 统一默认参数
export function getModelDefaultParameters(modelId: string): ModelDefaultParams {
  const map: Record<string, ModelDefaultParams> = {
    'pro/qwen/qwen2.5-vl-7b-instruct': { maxOutputTokens: 4096 },
    'qwen/qwq-32b': { enableThinking: true, thinkingBudget: 4096, includeThoughts: true, temperature: 0.7 },
    'qwen/qwq-32b-preview': { enableThinking: true, thinkingBudget: 4096, includeThoughts: true, temperature: 0.7 },
    'deepseek-ai/deepseek-v3.1': { enableThinking: true, thinkingBudget: 8192, includeThoughts: true, temperature: 0.6 },
    'deepseek-ai/deepseek-v3': { enableThinking: true, thinkingBudget: 8192, includeThoughts: true, temperature: 0.6 },
    'deepseek-ai/deepseek-v3.2-exp': { enableThinking: true, thinkingBudget: 8192, includeThoughts: true, temperature: 0.6 },
    'deepseek-ai/deepseek-v3.2': { enableThinking: true, thinkingBudget: 8192, includeThoughts: true, temperature: 0.6 },
  };
  const lower = toLower(modelId);
  if (map[lower]) return map[lower];
  if (lower.includes('qwq')) return { enableThinking: true, thinkingBudget: 4096, includeThoughts: true, temperature: 0.7 };
  if (lower.includes('deepseek')) return { enableThinking: true, thinkingBudget: 8192, includeThoughts: true, temperature: 0.6 };
  return {};
}

// 提供商/机型特定调整：例如 DeepSeek-V3.1 开启工具时关闭思维模式
export function applyProviderSpecificAdjustments(input: {
  modelId: string;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
}): Partial<ModelDefaultParams> {
  const lower = toLower(input.modelId);
  const isDeepseekV31 = lower === 'deepseek-ai/deepseek-v3.1' || lower === 'pro/deepseek-ai/deepseek-v3.1';
  if (input.supportsTools && isDeepseekV31) {
    return { thinkingBudget: undefined, enableThinking: false, includeThoughts: false };
  }
  return {};
}



// ========== 上下文窗口推断与输入预算 ==========

const DEFAULT_FALLBACK_CONTEXT_WINDOW = 100_000;
const MAX_CONTEXT_WINDOW_CAP = 2_000_000;
const MIN_CONTEXT_WINDOW_CAP = 8_192;
const MIN_OUTPUT_RESERVE = 1_024;
const MIN_INPUT_BUDGET = 2_048;
const DEFAULT_CONTEXT_HEADROOM_RATIO = 0.08;
const DEFAULT_CONTEXT_HEADROOM_TOKENS = 1_024;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 基于模型标识推断上下文窗口。
 *
 * 统一委托给 apiCapabilityEngine.inferApiCapabilities() 中的 CONTEXT_WINDOW_RULES，
 * 避免维护两套正则。当推断引擎无法匹配时，尝试根据 maxOutputTokens 启发式推导。
 *
 * 注意：这是推断默认值；用户可在 ApiConfig.contextWindow 或 Chat V2 高级面板中手动覆盖。
 */
export function inferModelContextWindow(
  modelLike: BasicModelDescriptor | string | null | undefined,
  maxOutputTokens?: number
): number {
  const modelId = typeof modelLike === 'string' ? modelLike : (modelLike?.id ?? '');
  const modelName = typeof modelLike === 'string' ? '' : (modelLike?.name ?? '');

  // 统一调用 apiCapabilityEngine 推断
  const caps: InferredApiCapabilities = inferApiCapabilities({ id: modelId, name: modelName });

  // 如果推断引擎命中了规则，直接使用其值
  if (caps.contextWindow > DEFAULT_FALLBACK_CONTEXT_WINDOW) {
    return caps.contextWindow;
  }

  // 推断引擎未命中（返回默认 32K）时，尝试根据 maxOutputTokens 启发式推导
  if (typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    return clampNumber(
      Math.max(DEFAULT_FALLBACK_CONTEXT_WINDOW, Math.floor(maxOutputTokens * 4)),
      MIN_CONTEXT_WINDOW_CAP,
      MAX_CONTEXT_WINDOW_CAP
    );
  }

  return caps.contextWindow; // DEFAULT_FALLBACK_CONTEXT_WINDOW (32_768)
}

export interface InputContextBudgetOptions {
  /** 用户手动覆盖的输入预算（若存在，优先返回） */
  userContextLimit?: number;
  /** 模型上限（总上下文窗口） */
  contextWindow?: number;
  /** 当前回合预留输出上限（maxTokens） */
  maxOutputTokens?: number;
  /** 安全余量比例（默认 8%） */
  headroomRatio?: number;
  /** 最小安全余量（默认 1024） */
  minHeadroomTokens?: number;
}

/**
 * 由“总上下文窗口 + 输出预留”推导“输入预算（max_input_tokens_override）”。
 */
export function deriveInputContextBudget(options: InputContextBudgetOptions): number {
  const {
    userContextLimit,
    contextWindow,
    maxOutputTokens,
    headroomRatio = DEFAULT_CONTEXT_HEADROOM_RATIO,
    minHeadroomTokens = DEFAULT_CONTEXT_HEADROOM_TOKENS,
  } = options;

  if (typeof userContextLimit === 'number' && Number.isFinite(userContextLimit) && userContextLimit > 0) {
    return Math.max(MIN_INPUT_BUDGET, Math.floor(userContextLimit));
  }

  const normalizedContextWindow = clampNumber(
    Math.floor(contextWindow ?? DEFAULT_FALLBACK_CONTEXT_WINDOW),
    MIN_CONTEXT_WINDOW_CAP,
    MAX_CONTEXT_WINDOW_CAP
  );
  const outputReserve = Math.max(MIN_OUTPUT_RESERVE, Math.floor(maxOutputTokens ?? 0));
  const headroom = Math.max(minHeadroomTokens, Math.floor(normalizedContextWindow * headroomRatio));

  const computed = normalizedContextWindow - outputReserve - headroom;
  const hardUpperBound = Math.max(MIN_INPUT_BUDGET, normalizedContextWindow - outputReserve);

  return clampNumber(computed, MIN_INPUT_BUDGET, hardUpperBound);
}

export function inferInputContextBudget(input: {
  modelLike: BasicModelDescriptor | string | null | undefined;
  userContextLimit?: number;
  maxOutputTokens?: number;
  /** 来自 ApiConfig.contextWindow 的用户配置值（优先于推断） */
  configContextWindow?: number;
}): number {
  // 优先使用 ApiConfig 中存储的 contextWindow（用户可编辑的配置值）
  const contextWindow =
    typeof input.configContextWindow === 'number' && input.configContextWindow > 0
      ? input.configContextWindow
      : inferModelContextWindow(input.modelLike, input.maxOutputTokens);
  return deriveInputContextBudget({
    userContextLimit: input.userContextLimit,
    contextWindow,
    maxOutputTokens: input.maxOutputTokens,
  });
}
