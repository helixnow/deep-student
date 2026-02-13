export type ApiCapabilityType =
  | 'reasoning'
  | 'vision'
  | 'function_calling'
  | 'web_search'
  | 'embedding'
  | 'rerank';

export interface ApiCapabilityOverride {
  type: ApiCapabilityType;
  isUserSelected?: boolean;
}

export interface ApiModelDescriptor {
  id: string;
  name?: string;
  capabilities?: ApiCapabilityOverride[];
}

export interface InferredApiCapabilities {
  reasoning: boolean;
  vision: boolean;
  functionCalling: boolean;
  webSearch: boolean;
  embedding: boolean;
  rerank: boolean;
  imageModel: boolean;
  supportsReasoningEffort: boolean;
  supportsThinkingTokens: boolean;
  supportsHybridReasoning: boolean;
  /** 推断的上下文窗口大小（tokens），基于模型 ID/名称的启发式匹配 */
  contextWindow: number;
}

const toLower = (value: string | undefined | null): string => (value ?? '').toLowerCase();

const getOverride = (descriptor: ApiModelDescriptor, type: ApiCapabilityType): boolean | undefined => {
  const list = descriptor.capabilities ?? [];
  const hit = list.find(item => item.type === type && item.isUserSelected !== undefined);
  if (!hit) return undefined;
  return !!hit.isUserSelected;
};

const EMBEDDING_REGEX = /(?:^text-|embed|bge-|e5-|llm2vec|retrieval|uae-|gte-|jina-clip|jina-embeddings|voyage-)/i;
const RERANK_REGEX = /(?:rerank|re-rank|re-ranker|re-ranking|retrieval|retriever)/i;

const IMAGE_MODEL_REGEX = /flux|diffusion|stabilityai|sd-|dall|cogview|janus|midjourney|mj-|image|gpt-image/i;

const IMAGE_MODEL_ID_SET = new Set(
  [
    'grok-2-image',
    'grok-2-image-1212',
    'grok-2-image-latest',
    'dall-e-3',
    'dall-e-2',
    'gpt-image-1',
    'gpt-image-1.5',
    'gpt-image-1-mini',
    // ⚠️ Gemini 2.0 系列将于 2026-03-31 关停
    'gemini-2.0-flash-exp',
    'gemini-2.0-flash-exp-image-generation',
    'gemini-2.0-flash-preview-image-generation',
    'gemini-2.5-flash-image',
  ].map(v => v.toLowerCase())
);

// 推理模型正则：o系列、gpt-5系列（除gpt-5-chat）、gpt-oss、codex-mini、各厂商推理模型
// Grok 系列：3-mini, 4, 4-fast, 4-1-fast, code-fast 都是推理模型（排除 -non-reasoning 变体）
// Mistral Magistral 系列：magistral-small/medium 是推理模型
const REASONING_REGEX = /^(?!.*-non-reasoning\b)(?:o\d+(?:-[\w-]+)?|gpt-5(?!-chat)[\w.-]*|gpt-oss|codex-mini|.*\b(?:reasoning|reasoner|thinking)\b.*|.*-[rR]\d+.*|.*\bqwq(?:-[\w-]+)?\b.*|.*\bhunyuan-t1(?:-[\w-]+)?\b.*|.*\bglm-zero-preview\b.*|.*\bgrok-(?:3-mini|4(?:-1)?(?:-fast)?|code-fast)(?:-[\w-]+)?\b.*|.*\bmagistral(?:-[\w-]+)?\b.*)$/i;

const VISION_ALLOWED_PATTERNS: (string | RegExp)[] = [
  // OCR 专用模型（DeepSeek-OCR、PaddleOCR-VL 等）
  'ocr',
  'llava',
  'moondream',
  'minicpm',
  // ⚠️ Gemini 1.5 已于 2026-01-29 关停，不再列入
  'gemini-2.0',
  'gemini-2.5',
  'gemini-2.5-flash-lite',
  'gemini-3',
  'gemini-flash-latest',
  'gemini-pro-latest',
  'gemini-flash-lite-latest',
  'gemini-exp',
  'claude-3',
  'claude-haiku-4',
  'claude-sonnet-4',
  'claude-opus-4',
  // Claude 4.1/4.5 系列
  'claude-opus-4-1',
  'claude-opus-4.1',
  'claude-opus-4-5',
  'claude-opus-4.5',
  'claude-sonnet-4-5',
  'claude-sonnet-4.5',
  'claude-haiku-4-5',
  'claude-haiku-4.5',
  // Claude 4.6 系列
  'claude-opus-4-6',
  'claude-opus-4.6',
  'vision',
  // 智谱仅 V 系列支持视觉，避免把 glm-4.7/4.6/5 等纯文本模型误判为多模态
  /glm-(?:4(?:\.\d+)?|5(?:\.\d+)?)v/i,
  'qwen-vl',
  'qwen2-vl',
  'qwen2.5-vl',
  'qwen3-vl',
  'qwen2.5-omni',
  'qwen3-omni',
  'qvq',
  'internvl2',
  'grok-vision-beta',
  'grok-4',
  'grok-4-fast',
  'grok-4-1-fast',
  'grok-3',
  'pixtral',
  'gpt-4',
  'gpt-4.1',
  'gpt-4o',
  'gpt-4.5',
  'gpt-5',
  'chatgpt-4o',
  'o1',
  'o3',
  'o4',
  'o3-pro',
  'codex-mini',
  'computer-use',
  'deepseek-vl',
  'kimi-latest',
  'kimi-thinking-preview',
  // Kimi K2.5 多模态（2026-01新增，支持图片+视频）
  'kimi-k2.5',
  'kimi-k2-5',
  'gemma-3',
  'doubao-seed-1.6',
  'doubao-seed-1-6',
  'doubao-seed-1.8',
  'doubao-seed-1-8',
  'kimi-vl-a3b-thinking',
  'llama-guard-4',
  'llama-4',
  'step-1o',
  'step-1v',
  'step-3',
  'step-r1-v',
  'qwen-omni',
];

const VISION_EXCLUDED_REGEXES: RegExp[] = [
  /gpt-4-\d+-preview/i,
  /gpt-4-turbo-preview/i,
  /gpt-4-32k/i,
  /gpt-4-\d+/i,
  /\bo1-mini\b/i,
  /\bo3-mini\b/i,
  /\bo1-preview\b/i,
  /aidc-ai\/marco-o1/i,
  /gpt-oss/i, // gpt-oss 仅支持文本
  /gpt-5-chat/i, // gpt-5-chat 仅支持文本输出
  /grok-code-fast/i, // grok-code-fast 专为代码优化，不支持视觉
  /grok-3-mini/i, // grok-3-mini 为纯文本推理模型，不支持视觉
];

// 函数调用支持白名单：OpenAI GPT系列、o系列、各厂商主流模型
// 2026-01: 添加 kimi-k2.5/k2-5 支持
// 2026-01: 添加 doubao-seed-1.8 支持
const FUNCTION_CALLING_WHITELIST_REGEX = /(gpt-4o-mini|gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4(?!-\d)|gpt-oss|gpt-5|o[134]\b|o3-pro|codex-mini|computer-use|claude|qwen3?|hunyuan|deepseek|glm-(?:4(?:\.[5-7])?|5(?:\.\d+)?)|learnlm|gemini(?!.*embedding)|grok-[34]|doubao-seed-1(?:\.[68]|-[68])|kimi-(?:k2(?:\.5|-5)?|latest|vl)|ling-[\w-]+|ring-[\w-]+|minimax-m2|devstral)/i;

const FUNCTION_CALLING_EXCLUDED_REGEXES: RegExp[] = [
  /\baqa\b/i,
  /imagen/i,
  /\bo1-mini\b/i,
  /\bo1-preview\b/i,
  /aidc-ai\/marco-o1/i,
  /gemini-1[\w-]*/i,
  /qwen-mt/i,
  /gpt-5-chat/i,
  /glm-(?:4(?:\.\d+)?|5(?:\.\d+)?)v/i,
  /hunyuan-mt/i, // 排除 Hunyuan-MT 翻译系列，不支持工具调用
  /deepseek-v3\.2-speciale/i, // DeepSeek V3.2-Speciale 不支持工具调用
];

// Web Search 支持白名单
const WEB_SEARCH_WHITELIST_REGEXES: RegExp[] = [
  /\bgpt-4o-search-preview\b/i,
  /\bgpt-4o-mini-search-preview\b/i,
  /\bgpt-4\.1(?!-nano)\b/i,
  /\bgpt-4o(?!-image)\b/i,
  /\bgpt-5(?!-chat)\b/i,
  /\bsonar-deep-research\b/i,
  /\bsonar-reasoning-pro\b/i,
  /\bsonar-reasoning\b/i,
  /\bsonar-pro\b/i,
  /\bsonar\b/i,
  // Gemini 2.x/3.x 系列（排除 image/tts 专用模型）
  /gemini-(?:2|3)(?:\.\d)?(?!.*(?:image|tts))[\w.-]*$/i,
  /gemini-(?:flash-latest|pro-latest|flash-lite-latest)/i,
];

// Gemini Thinking 支持：2.5系列（除了image/tts）、3系列
const GEMINI_THINKING_REGEX = /^(?:gemini-(?:2\.5|3)[^\s]*|gemini-(?:flash-latest|pro-latest|flash-lite-latest))/i;

// Qwen Thinking Token 模式支持：qwen-plus/turbo/flash 以及 qwen3 系列
const QWEN_PLUS_REGEX = /^qwen-plus/i;
const QWEN_TURBO_REGEX = /^qwen-turbo/i;
const QWEN_FLASH_REGEX = /^qwen-flash/i;
// Qwen3 商业模型正则
const QWEN3_MAX_REGEX = /^qwen3?-max/i;

// Claude Extended Thinking 支持模型：3.7+ 和所有 Claude 4.x 系列
const CLAUDE_THINKING_PATTERNS = [
  'claude-3-7-sonnet',
  'claude-3.7-sonnet',
  'claude-sonnet-4',
  'claude-opus-4',
  'claude-haiku-4',
  // Claude 4.1 系列
  'claude-opus-4-1',
  'claude-opus-4.1',
  // Claude 4.5 系列
  'claude-opus-4-5',
  'claude-opus-4.5',
  'claude-sonnet-4-5',
  'claude-sonnet-4.5',
  'claude-haiku-4-5',
  'claude-haiku-4.5',
  // Claude 4.6 系列
  'claude-opus-4-6',
  'claude-opus-4.6',
];

const DOUBAO_THINKING_REGEXES: RegExp[] = [
  /doubao-1\.5-thinking-vision-pro/i,
  /doubao-1-5-thinking-vision-pro/i,
  /doubao-1\.5-thinking-pro-m/i,
  /doubao-1-5-thinking-pro-m/i,
];

// Gemini 排除 image/tts/audio 专用模型的 thinking 能力
const GEMINI_IMAGE_EXCLUDE_REGEX = /(image|tts|audio)/i;
// GLM 4.5/4.6/4.7/5 支持思维链 (Preserved Thinking / Interleaved Thinking)
const ZHIPU_GLM_THINKING_REGEX = /glm-(?:4\.[5-7]|5(?:\.\d+)?)/i;
// 通用匹配所有 GLM 视觉模型（以 v 结尾的版本号，如 glm-4.5v, glm-4.6v, glm-5v, glm-5.1v）
const ZHIPU_GLM_VISION_REGEX = /glm-(?:4(?:\.\d+)?|5(?:\.\d+)?)v/i;

// Kimi K2/K2.5 Thinking 系列支持思维链回传 (reasoning_content)
// - kimi-k2-thinking, kimi-k2-0711-thinking 等 K2 Thinking 变体
// - kimi-k2.5, kimi-k2-5 等 K2.5 多模态（默认启用 thinking）
// - kimi-thinking-preview, kimi-vl-a3b-thinking 等预览/VL 版本
const KIMI_K2_THINKING_REGEX = /kimi-(?:k2(?:\.5|-5)?(?:-[\w-]*)?thinking|k2\.5|k2-5|thinking-preview|vl-[\w-]*thinking)/i;

// MiniMax M2/M2.1 系列支持思维链回传 (不回传性能降 3-40%)
const MINIMAX_THINKING_REGEXES: RegExp[] = [
  /minimax-m2(?:\.\d)?/i,
  /abab7/i,
  /minimax-text-01/i,
];

// Gemini 3 系列支持 thoughtSignature（工具调用时必须回传）
const GEMINI_3_THINKING_REGEX = /gemini-3/i;

// Perplexity sonar-reasoning-pro 基于 DeepSeek-R1，暴露推理内容
const PERPLEXITY_REASONING_REGEX = /sonar-reasoning-pro/i;

// DeepSeek 混合推理模型：V3.1+ 支持 thinking_mode 动态切换
// - deepseek-chat 对应非思考模式，deepseek-reasoner 对应思考模式
// - V3.2-Speciale 不支持工具调用
// 注意：R1 不支持混合推理，多轮对话时 reasoning_content 被忽略
const DEEPSEEK_HYBRID_REGEXES: RegExp[] = [
  /deepseek-v3[.-]\d/i,
  /deepseek-chat(?!-v2)/i, // deepseek-chat (V3.2) 但排除 v2 系列
  /deepseek-reasoner/i, // deepseek-reasoner (V3.2)
];

// ========== 上下文窗口推断表 ==========
// first-match-wins，具体模式在前，通用回退在后。
// 数据来源：各厂商 2025-2026 官方文档，取主流/保守值。

const DEFAULT_CONTEXT_WINDOW = 100_000;

const CONTEXT_WINDOW_RULES: Array<{ pattern: RegExp; window: number }> = [
  // --- 1M 级 ---
  // GPT-4.1 系列：1,047,576 tokens（OpenAI 官方 2025-04）
  { pattern: /gpt-4\.1/i, window: 1_000_000 },
  // Gemini 2.0/2.5/3 系列：1,048,576 tokens（Google Cloud 官方）
  // ⚠️ Gemini 1.5 已于 2026-01-29 关停
  { pattern: /gemini-(?:2\.[05]|3)/i, window: 1_000_000 },
  // Gemini 别名（flash-latest/pro-latest 等指向 2.5+ 系列）
  { pattern: /gemini-(?:flash-latest|pro-latest|flash-lite-latest)/i, window: 1_000_000 },

  // --- 2M 级 ---
  // Grok 4.1 Fast / Grok 4 Fast：2,000,000 tokens（xAI 官方 2026-02）
  { pattern: /grok-4.*fast/i, window: 2_000_000 },

  // --- 400K 级 ---
  // GPT-5 / GPT-5.2 系列：400K tokens（OpenAI 官方 2025）
  { pattern: /gpt-5/i, window: 400_000 },

  // --- 256K 级 ---
  // Kimi K2.5：262,144 tokens（Moonshot 官方 2026-01）; K2: 128-256K
  { pattern: /kimi|moonshot/i, window: 256_000 },
  // Codestral：256K tokens（Mistral 官方 2025-07）
  { pattern: /codestral/i, window: 256_000 },
  // Qwen3-Max：256K tokens（阿里云官方）; Qwen-Long: 10M（取 256K 保守值）
  { pattern: /qwen3?-max|qwen-long/i, window: 256_000 },
  // Doubao 256K 变体 + Seed 系列：256K tokens（火山引擎官方）
  { pattern: /doubao.*256k|doubao-seed/i, window: 256_000 },
  // Mistral Large 3：256K tokens（Mistral 官方 2025-12，675B MoE）
  { pattern: /mistral-large-3/i, window: 256_000 },

  // --- 200K 级 ---
  // Claude 全系列：标准 200K；beta 1M（取标准值 200K）（Anthropic 官方 2026-02）
  { pattern: /claude|anthropic/i, window: 200_000 },
  // OpenAI o 系列：o1/o3/o4-mini 200K tokens; codex-mini 200K（OpenAI 官方 2025）
  { pattern: /\bo[1-4]\b|\bo1-|\bo3-|\bo4-|codex-mini/i, window: 200_000 },
  // MiniMax M2 / abab6.5：200K tokens（MiniMax 官方）
  { pattern: /minimax|abab/i, window: 200_000 },
  // GLM-4.5/4.6/4.7/5：200K tokens（智谱官方）
  { pattern: /glm-(?:4\.[5-9]|5(?:\.\d+)?)/i, window: 200_000 },

  // --- 131K 级 ---
  // Grok 3/3-mini/4 标准：131,072 tokens（xAI 官方）
  { pattern: /grok/i, window: 131_072 },

  // --- 128K 级 ---
  // GPT-4o / GPT-4.5：128K tokens（OpenAI 官方）
  { pattern: /gpt-4o|gpt-4\.5/i, window: 128_000 },
  // DeepSeek V3.1/V3.2：128K tokens（DeepSeek 官方）
  { pattern: /deepseek/i, window: 128_000 },
  // ERNIE-4.5：128K tokens（百度官方）
  { pattern: /ernie|baidu/i, window: 128_000 },
  // Doubao 通用（非 256K/Seed 变体）：128K tokens（火山引擎官方）
  { pattern: /doubao/i, window: 128_000 },
  // Qwen 通用（非 Max/Long 变体）/ QwQ：128K tokens（阿里云官方）
  { pattern: /qwen|qwq/i, window: 128_000 },
  // GLM 通用（4.0 等旧版）：128K tokens（智谱官方）
  { pattern: /glm|zhipu|chatglm/i, window: 128_000 },
  // Mistral Large/Small / Mixtral / Magistral / Devstral：128K tokens（Mistral 官方）
  { pattern: /mistral|mixtral|magistral|devstral/i, window: 128_000 },
  // 华为盘古/腾讯混元：128K tokens（保守值）
  { pattern: /hunyuan/i, window: 128_000 },
  // Llama 4 系列：128K tokens
  { pattern: /llama-4|llama4/i, window: 128_000 },
  // Step 系列（阶跃星辰）：128K tokens
  { pattern: /step-/i, window: 128_000 },
];

/**
 * 根据模型 ID 和名称推断上下文窗口大小。
 * 使用 first-match-wins 策略，具体模式优先于通用模式。
 *
 * @param fingerprint - 小写的 "id name" 拼接字符串
 * @returns 推断的上下文窗口大小（tokens）
 */
function inferContextWindow(fingerprint: string): number {
  for (const rule of CONTEXT_WINDOW_RULES) {
    if (rule.pattern.test(fingerprint)) {
      return rule.window;
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}

const matchesPatternList = (value: string, patterns: (string | RegExp)[]): boolean => {
  if (!value) return false;
  for (const pattern of patterns) {
    if (typeof pattern === 'string') {
      if (value.includes(pattern)) return true;
    } else if (pattern.test(value)) {
      return true;
    }
  }
  return false;
};

const matchesRegexList = (value: string, regexes: RegExp[]): boolean => {
  if (!value) return false;
  return regexes.some(regex => regex.test(value));
};

export function inferApiCapabilities(descriptor: ApiModelDescriptor): InferredApiCapabilities {
  const id = toLower(descriptor.id);
  const name = toLower(descriptor.name);

  const embeddingOverride = getOverride(descriptor, 'embedding');
  const embedding = embeddingOverride !== undefined ? embeddingOverride : EMBEDDING_REGEX.test(id) || (name ? EMBEDDING_REGEX.test(name) : false);

  const rerankOverride = getOverride(descriptor, 'rerank');
  const rerank = rerankOverride !== undefined ? rerankOverride : RERANK_REGEX.test(id) || (name ? RERANK_REGEX.test(name) : false);

  const imageModelById = IMAGE_MODEL_ID_SET.has(id);
  const imageModel = imageModelById || IMAGE_MODEL_REGEX.test(id) || (name ? IMAGE_MODEL_REGEX.test(name) : false);

  const reasoningOverride = getOverride(descriptor, 'reasoning');
  let reasoning = false;
  if (reasoningOverride !== undefined) {
    reasoning = reasoningOverride;
  } else if (!embedding && !rerank && !imageModel) {
    reasoning = REASONING_REGEX.test(id) || (name ? REASONING_REGEX.test(name) : false);
  }

  const visionOverride = getOverride(descriptor, 'vision');
  let vision = false;
  if (visionOverride !== undefined) {
    vision = visionOverride;
  } else if (!embedding && !rerank) {
    const allowed = matchesPatternList(id, VISION_ALLOWED_PATTERNS) || (name ? matchesPatternList(name, VISION_ALLOWED_PATTERNS) : false);
    const excluded = matchesRegexList(id, VISION_EXCLUDED_REGEXES) || (name ? matchesRegexList(name, VISION_EXCLUDED_REGEXES) : false);
    vision = allowed && !excluded;
  }

  const functionOverride = getOverride(descriptor, 'function_calling');
  let functionCalling = false;
  if (functionOverride !== undefined) {
    functionCalling = functionOverride;
  } else if (!embedding && !rerank && !imageModel) {
    const excluded = matchesRegexList(id, FUNCTION_CALLING_EXCLUDED_REGEXES) || (name ? matchesRegexList(name, FUNCTION_CALLING_EXCLUDED_REGEXES) : false);
    const allowed = FUNCTION_CALLING_WHITELIST_REGEX.test(id) || (name ? FUNCTION_CALLING_WHITELIST_REGEX.test(name) : false);
    functionCalling = allowed && !excluded;
  }

  const webOverride = getOverride(descriptor, 'web_search');
  let webSearch = false;
  if (webOverride !== undefined) {
    webSearch = webOverride;
  } else if (!embedding && !rerank && !imageModel) {
    webSearch = WEB_SEARCH_WHITELIST_REGEXES.some(regex => regex.test(id) || (name ? regex.test(name) : false));
  }

  // OpenAI reasoning_effort 支持：o1/o3/o4系列、gpt-5系列（除gpt-5-chat）、gpt-oss、codex-mini
  const isOpenaiReasoningBudget =
    (id.includes('o1') && !id.includes('o1-preview') && !id.includes('o1-mini')) ||
    id.includes('o3') ||
    id.includes('o4') ||
    id.includes('gpt-oss') ||
    id.includes('codex-mini') ||
    (id.includes('gpt-5') && !id.includes('gpt-5-chat'));

  // Grok: 只有 grok-3-mini 支持 reasoning_effort 参数
  // grok-4, grok-4-fast, grok-4-1-fast 都不支持 reasoning_effort
  const isGrokReasoningBudget = id.includes('grok-3-mini');

  const isPerplexityReasoningBudget = id.includes('sonar-deep-research');

  const supportsReasoningEffort = !embedding && !rerank && !imageModel && (isOpenaiReasoningBudget || isGrokReasoningBudget || isPerplexityReasoningBudget);

  const isGeminiThinking =
    GEMINI_THINKING_REGEX.test(id) &&
    !GEMINI_IMAGE_EXCLUDE_REGEX.test(id);

  let isQwenTokenModel = false;
  let isQwenThinkingModel = false;
  if (!id.includes('coder')) {
    // Qwen3 系列支持 thinking/non-thinking 模式切换
    if (id.startsWith('qwen3')) {
      // qwen3-max-preview 支持 thinking 模式
      if (id.includes('preview')) {
        isQwenTokenModel = true;
      } else if (!id.includes('max') && !id.includes('instruct') && !id.includes('thinking')) {
        isQwenTokenModel = true;
      }
      if (id.includes('thinking')) {
        isQwenThinkingModel = true;
      }
    }
    // qwen-plus/turbo/flash 商业模型支持 thinking token
    if (QWEN_PLUS_REGEX.test(id) || QWEN_TURBO_REGEX.test(id) || QWEN_FLASH_REGEX.test(id)) {
      isQwenTokenModel = true;
    }
    // qwen3-max-preview / qwen-max-latest 等预览版支持 thinking
    if (QWEN3_MAX_REGEX.test(id) && id.includes('preview')) {
      isQwenTokenModel = true;
    }
  }

  const isClaudeThinking = CLAUDE_THINKING_PATTERNS.some(pattern => id.includes(pattern));

  // Doubao Seed 1.6/1.8 全系列支持 thinking 模式（包括带 -thinking 后缀和不带的）
  const isDoubaoSeedThinking =
    id.includes('doubao-seed-1.6') || id.includes('doubao-seed-1-6') ||
    id.includes('doubao-seed-1.8') || id.includes('doubao-seed-1-8');

  const isDoubaoThinking = matchesRegexList(id, DOUBAO_THINKING_REGEXES) || isDoubaoSeedThinking;

  const isHunyuanThinking = id.includes('hunyuan-a13b') || id.includes('hunyuan-t1');

  const isZhipuThinking = ZHIPU_GLM_THINKING_REGEX.test(id) && !ZHIPU_GLM_VISION_REGEX.test(id);

  // Kimi K2 Thinking 系列
  const isKimiK2Thinking = KIMI_K2_THINKING_REGEX.test(id);

  // MiniMax M2/M2.1 系列（思维链必须回传，否则性能下降 3-40%）
  const isMinimaxThinking = matchesRegexList(id, MINIMAX_THINKING_REGEXES);

  // Gemini 3 系列（工具调用时 thoughtSignature 必须回传）
  const isGemini3Thinking = GEMINI_3_THINKING_REGEX.test(id) && !GEMINI_IMAGE_EXCLUDE_REGEX.test(id);

  // Perplexity sonar-reasoning-pro（基于 DeepSeek-R1）
  const isPerplexityReasoning = PERPLEXITY_REASONING_REGEX.test(id);

  const supportsThinkingTokens =
    !embedding &&
    !rerank &&
    !imageModel &&
    (isGeminiThinking ||
      isGemini3Thinking ||
      isQwenTokenModel ||
      isQwenThinkingModel ||
      isClaudeThinking ||
      isDoubaoThinking ||
      isHunyuanThinking ||
      isZhipuThinking ||
      isKimiK2Thinking ||
      isMinimaxThinking ||
      isPerplexityReasoning);

  const supportsHybridReasoning =
    !embedding &&
    !rerank &&
    !imageModel &&
    DEEPSEEK_HYBRID_REGEXES.some(regex => regex.test(id));

  // 上下文窗口推断：使用 id + name 拼接作为指纹，提高匹配率
  const contextWindow = inferContextWindow(`${id} ${name}`);

  return {
    reasoning,
    vision,
    functionCalling,
    webSearch,
    embedding,
    rerank,
    imageModel,
    supportsReasoningEffort,
    supportsThinkingTokens,
    supportsHybridReasoning,
    contextWindow,
  };
}
