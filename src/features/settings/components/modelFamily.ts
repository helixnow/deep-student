/**
 * 模型家族分类
 *
 * 把 modelId 映射到一个"家族"（如 GPT-4、Claude Opus、Gemini 2.5），
 * 用于供应商详情页按家族分组渲染。
 *
 * 设计原则：
 * - 规则有序匹配，靠前的优先
 * - 不识别的模型归入 OTHER_FAMILY（order 极大，排在最后）
 * - 处理形如 "openai/gpt-4o" 的带前缀 ID（取最后一段）
 */

export interface ModelFamily {
  id: string;
  label: string;
  order: number;
}

interface FamilyRule {
  pattern: RegExp;
  family: ModelFamily;
}

const FAMILY_RULES: FamilyRule[] = [
  // === OpenAI ===
  { pattern: /^o[1-9](?:[-_]|$)/i, family: { id: 'openai-o', label: 'o-series', order: 1 } },
  { pattern: /^gpt-5/i, family: { id: 'gpt-5', label: 'GPT-5', order: 2 } },
  // 兼容 chatgpt-4o-latest 等以 chatgpt- 开头的别名
  { pattern: /^(?:chatgpt-|gpt-)4/i, family: { id: 'gpt-4', label: 'GPT-4', order: 3 } },
  { pattern: /^gpt-3/i, family: { id: 'gpt-3.5', label: 'GPT-3.5', order: 4 } },

  // === Anthropic ===
  { pattern: /claude.*opus/i, family: { id: 'claude-opus', label: 'Claude Opus', order: 10 } },
  { pattern: /claude.*sonnet/i, family: { id: 'claude-sonnet', label: 'Claude Sonnet', order: 11 } },
  { pattern: /claude.*haiku/i, family: { id: 'claude-haiku', label: 'Claude Haiku', order: 12 } },
  // 旧版 Claude 2 / Claude Instant — tier 命名出现前的产线
  { pattern: /^claude-(?:2|instant)/i, family: { id: 'claude-legacy', label: 'Claude (Legacy)', order: 13 } },

  // === Google ===
  { pattern: /gemini-?2\.5/i, family: { id: 'gemini-2.5', label: 'Gemini 2.5', order: 20 } },
  { pattern: /gemini-?2\.0/i, family: { id: 'gemini-2.0', label: 'Gemini 2.0', order: 21 } },
  { pattern: /gemini-?1\.5/i, family: { id: 'gemini-1.5', label: 'Gemini 1.5', order: 22 } },
  { pattern: /^gemini/i, family: { id: 'gemini', label: 'Gemini', order: 23 } },
  { pattern: /^gemma/i, family: { id: 'gemma', label: 'Gemma', order: 24 } },

  // === DeepSeek ===
  { pattern: /deepseek[-_]?(?:r\d|reasoner)/i, family: { id: 'deepseek-r', label: 'DeepSeek Reasoner', order: 30 } },
  { pattern: /deepseek[-_]?vl/i, family: { id: 'deepseek-vl', label: 'DeepSeek VL', order: 31 } },
  { pattern: /deepseek[-_]?coder/i, family: { id: 'deepseek-coder', label: 'DeepSeek Coder', order: 32 } },
  // V 系列（V2、V2.5、V3 base/chat），不能再让它落到 chat 兜底
  { pattern: /deepseek[-_]?v\d/i, family: { id: 'deepseek-v', label: 'DeepSeek V', order: 33 } },
  { pattern: /deepseek/i, family: { id: 'deepseek-chat', label: 'DeepSeek Chat', order: 34 } },

  // === Qwen ===
  { pattern: /^qvq/i, family: { id: 'qvq', label: 'QvQ', order: 38 } },
  { pattern: /qwq/i, family: { id: 'qwq', label: 'QwQ', order: 39 } },
  { pattern: /qwen[-_]?3/i, family: { id: 'qwen-3', label: 'Qwen 3', order: 40 } },
  { pattern: /qwen[-_]?2\.5/i, family: { id: 'qwen-2.5', label: 'Qwen 2.5', order: 41 } },
  { pattern: /qwen[-_]?2/i, family: { id: 'qwen-2', label: 'Qwen 2', order: 42 } },
  { pattern: /qwen.*vl/i, family: { id: 'qwen-vl', label: 'Qwen VL', order: 43 } },
  { pattern: /^qwen/i, family: { id: 'qwen', label: 'Qwen', order: 44 } },

  // === Meta Llama ===
  { pattern: /llama-?3/i, family: { id: 'llama-3', label: 'Llama 3', order: 50 } },
  { pattern: /llama-?2/i, family: { id: 'llama-2', label: 'Llama 2', order: 51 } },

  // === Mistral ===
  { pattern: /mixtral/i, family: { id: 'mixtral', label: 'Mixtral', order: 60 } },
  { pattern: /codestral/i, family: { id: 'codestral', label: 'Codestral', order: 61 } },
  { pattern: /mistral/i, family: { id: 'mistral', label: 'Mistral', order: 62 } },

  // === 国内大模型 ===
  { pattern: /^mimo/i, family: { id: 'mimo', label: 'MiMo', order: 70 } },
  { pattern: /^glm/i, family: { id: 'glm', label: 'GLM', order: 71 } },
  { pattern: /(?:moonshot|kimi)/i, family: { id: 'moonshot', label: 'Moonshot', order: 72 } },
  { pattern: /(?:doubao|skylark|seed-)/i, family: { id: 'doubao', label: 'Doubao', order: 73 } },
  { pattern: /hunyuan/i, family: { id: 'hunyuan', label: 'Hunyuan', order: 74 } },
  { pattern: /^abab/i, family: { id: 'minimax', label: 'MiniMax', order: 75 } },
  { pattern: /^yi[-_]/i, family: { id: 'yi', label: 'Yi', order: 76 } },

  // === 能力分类（fallback） ===
  // 注意：reranker 必须先于 embedding 检查（匹配顺序），但显示顺序让 embedding 在前（order 小）
  { pattern: /(?:^|[-_/])rerank(?:er)?(?:[-_]|$)/i, family: { id: 'reranker', label: 'Reranker', order: 901 } },
  { pattern: /(?:^|[-_/])(?:text-embedding|embedding|embed|bge|m3e|gte|e5)(?:[-_]|$)/i, family: { id: 'embedding', label: 'Embeddings', order: 900 } },
  { pattern: /whisper/i, family: { id: 'whisper', label: 'Whisper', order: 902 } },
  { pattern: /(?:^|-)tts(?:[-_]|$)/i, family: { id: 'tts', label: 'TTS', order: 903 } },
  { pattern: /dall-?e/i, family: { id: 'dalle', label: 'DALL·E', order: 904 } },
];

const OTHER_FAMILY: ModelFamily = { id: 'other', label: 'Other', order: 9999 };

const stripProviderPrefix = (modelId: string): string => {
  if (!modelId) return '';
  const idx = modelId.lastIndexOf('/');
  return idx >= 0 ? modelId.slice(idx + 1) : modelId;
};

export function classifyModelFamily(modelId: string): ModelFamily {
  const normalized = stripProviderPrefix(modelId).trim();
  if (!normalized) return OTHER_FAMILY;

  for (const rule of FAMILY_RULES) {
    if (rule.pattern.test(normalized)) {
      return rule.family;
    }
  }
  return OTHER_FAMILY;
}

export interface ModelFamilyGroup<T> {
  family: ModelFamily;
  items: T[];
}

export function groupByModelFamily<T>(
  models: T[],
  getModelId: (item: T) => string,
): ModelFamilyGroup<T>[] {
  const groups = new Map<string, ModelFamilyGroup<T>>();
  for (const model of models) {
    const id = getModelId(model);
    const family = classifyModelFamily(id);
    let group = groups.get(family.id);
    if (!group) {
      group = { family, items: [] };
      groups.set(family.id, group);
    }
    group.items.push(model);
  }
  return Array.from(groups.values()).sort((a, b) => a.family.order - b.family.order);
}
