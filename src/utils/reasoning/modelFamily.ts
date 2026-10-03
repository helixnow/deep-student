// 模型家族包含匹配（方案 E，2026-10-03）。
//
// 匹配规则：对模型 ID 做全小写**包含**匹配（不再锚定前缀）——
// `codex666-glm-5.3-flash` 包含 "glm" → 智谱家族，包含 "5.3" → (5,3) 版本。
// 一个 ID 可能同时包含多个家族词（如中转站加的任意前缀），按 KEYWORD_ORDER
// 的固定优先级取第一个命中；`o1/o3/o4` 这类短词保留词边界正则特例
//（裸包含会误命中大量无关 ID，如 "prompt3"）。

export type ModelFamily =
  | 'qwen'
  | 'deepseek'
  | 'zhipu'
  | 'moonshot'
  | 'grok'
  | 'gemini'
  | 'claude'
  | 'openai'
  | 'doubao'
  | 'minimax'
  | 'ernie'
  | 'mimo'
  | 'mistral';

/** 家族关键词（小写包含匹配）。数组序即优先级：先命中先得。 */
export const FAMILY_KEYWORDS: ReadonlyArray<readonly [ModelFamily, readonly string[]]> = [
  ['deepseek', ['deepseek']],
  ['qwen', ['qwen', 'qwq']],
  ['zhipu', ['glm', 'chatglm']],
  ['moonshot', ['kimi', 'moonshot']],
  ['grok', ['grok']],
  ['gemini', ['gemini']],
  ['claude', ['claude']],
  ['openai', ['gpt', 'chatgpt', 'codex', 'gpt-oss']],
  ['doubao', ['doubao']],
  ['minimax', ['minimax', 'abab']],
  ['ernie', ['ernie', 'wenxin']],
  ['mimo', ['mimo']],
  ['mistral', ['mistral', 'magistral']],
];

export const FAMILY_KEYWORD_ORDER: ReadonlyArray<ModelFamily> = FAMILY_KEYWORDS.map(([family]) => family);

const toId = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

/** 家族包含匹配；未命中返回 undefined。 */
export function matchModelFamily(modelId: unknown): ModelFamily | undefined {
  const id = toId(modelId);
  if (!id) return undefined;
  for (const [family, keywords] of FAMILY_KEYWORDS) {
    if (keywords.some(keyword => id.includes(keyword))) return family;
  }
  return undefined;
}

/**
 * 从模型 ID 任意位置提取首个 `x.y` 版本号（包含式，不锚定前缀）。
 * `codex666-glm-5.3-flash` → [5,3]；`grok-4.7` → [4,7]；`qwen3.8-max` → [3,8]。
 * 纯整数段（如 `128k`、`v2`）不构成版本；日期快照（如 `-0905`、`20260517`）不匹配
 * `x.y` 形态，自然跳过。
 */
export function extractModelVersion(modelId: unknown): [number, number] | undefined {
  const id = toId(modelId);
  if (!id) return undefined;
  const match = id.match(/(\d{1,2})\.(\d{1,2})/);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return undefined;
  return [major, minor];
}

/** o 系列词边界匹配（特例：裸包含误报率过高）。`gpt-3`/`prompt3` 不误命中。 */
export function matchesOpenAiOSeries(modelId: unknown): boolean {
  const id = toId(modelId);
  return /(?:^|[/_-])o[134](?:[.\-_/]|$)/.test(id);
}

/** OpenAI 家族（gpt/codex/gpt-oss）包含匹配；o 系列单独用 matchesOpenAiOSeries。 */
export function matchesOpenAiGptFamily(modelId: unknown): boolean {
  const id = toId(modelId);
  return id.includes('gpt') || id.includes('chatgpt') || id.includes('codex');
}

/** 是否为 GPT-6 系（sol/luna/astra 等变体）。 */
export function isGpt6ModelId(modelId: unknown): boolean {
  const id = toId(modelId);
  return /(?:^|[/_-])gpt-?6(?:[.\-_/]|$)/.test(id);
}
