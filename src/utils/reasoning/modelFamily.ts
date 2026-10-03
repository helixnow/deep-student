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

// ── 以下判定自 2026-10-03 起由 modelFamily 统一持有 ──────────────────────
//
// 此前这些判定分散在 `src/utils/deepseekReasoningControls.ts`（按渠道分组的
// 大文件），导致同一事实在前端存在两份实现。现全部收敛到家族模块，
// 渠道文件（channels.ts）只做编排。

/** 家族名到该家族的模型名判定函数集合（供渠道按身份取用）。 */

/** DeepSeek 遗留别名（已于 2026-07-24 停用，仅识别存量配置）。 */
export function isDeepSeekLegacyAliasModelId(modelId: unknown): boolean {
  const id = toId(modelId);
  return id === 'deepseek-chat' || id === 'deepseek-reasoner';
}

/** DeepSeek V4 一等模型（含 V4.1 Flash `deepseek-flash` 与 SiliconFlow 托管形态）。 */
export function isDeepSeekV4ModelId(modelId: unknown): boolean {
  const id = toId(modelId);
  if (id.includes('deepseek-v4') || id.includes('deepseek-flash')) return true;
  return isDeepSeekLegacyAliasModelId(id);
}

export function isDeepSeekV32ModelId(modelId: unknown): boolean {
  return toId(modelId).includes('deepseek-v3.2');
}

/** DeepSeek R1 系（强制思考）。 */
export function isDeepSeekR1ModelId(modelId: unknown): boolean {
  return toId(modelId).includes('deepseek-r1');
}

/** QwQ / qwen3-*-thinking / qwen3.7-max-preview 等强制思考变体。 */
export function isQwenForcedThinkingModelId(modelId: unknown): boolean {
  const id = toId(modelId);
  if (id.includes('qwq')) return true;
  if (/qwen3[.-]7-max-preview(?:[-_/]|$)/.test(id)) return true;
  if (/qwen3[.-]7-max-(?:2026-05-17|20260517)(?:[-_/]|$)/.test(id)) return true;
  return id.includes('qwen3') && /(?:^|[-_/])thinking(?:[-_/]|$)/.test(id);
}

/** Qwen 纯推理型号（无法关闭思考），如 qwen3.8-2.4t-a95b。 */
export function isQwenPureThinkingModelId(modelId: unknown): boolean {
  const id = toId(modelId);
  return id.includes('qwen3.8') && id.includes('2.4t');
}

/** Kimi K3+：始终推理，无 thinking 参数。 */
export function isKimiK3OrLaterModelId(modelId: unknown): boolean {
  const id = toId(modelId);
  if (!id.includes('kimi') && !id.includes('moonshot')) return false;
  const match = id.match(/(?:^|[^a-z0-9])k(\d+)/);
  return !!match && Number(match[1]) >= 3;
}

/** 遗留 Kimi 强制思考型号（kimi-k2-thinking / kimi-vl-*-thinking 等）。 */
export function isLegacyKimiForcedThinkingModelId(modelId: unknown): boolean {
  const id = toId(modelId);
  return (
    id.includes('kimi-k2-thinking') ||
    id.includes('kimi-thinking-preview') ||
    (id.includes('kimi-vl-') && id.includes('thinking'))
  );
}

/** 按 `family<ver>` 形态解析版本（如 glm-5.3、grok-4.7）。 */
function parseVersionAfterPrefix(modelId: string, prefix: string): [number, number] | undefined {
  const match = modelId.match(
    new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[-]?(\\d+)(?:[.-](\\d{1,2}))?`)
  );
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0)];
}

/** GLM-5.2 及以上（含 `glm5.2` 无连字符形态）。 */
export function isGlm52OrLaterModelId(modelId: unknown): boolean {
  const version = parseVersionAfterPrefix(toId(modelId), 'glm');
  return !!version && (version[0] > 5 || (version[0] === 5 && version[1] >= 2));
}

/** Grok 4.3 及以上（含 `grok-latest` 别名）。 */
export function isGrok43OrLaterModelId(modelId: unknown): boolean {
  const id = toId(modelId);
  if (id.includes('non-reasoning')) return false;
  if (id === 'grok-latest' || id.endsWith('/grok-latest')) return true;
  const version = parseVersionAfterPrefix(id, 'grok');
  return !!version && (version[0] > 4 || (version[0] === 4 && version[1] >= 3));
}

export function isGrokMultiAgentModelId(modelId: unknown): boolean {
  return /grok-4[.-]20[\w.-]*multi-agent/.test(toId(modelId));
}

/** Mistral Medium 3.5 / Small 4 系（支持 reasoning_effort）。 */
export function isMistralEffortModelId(modelId: unknown): boolean {
  const id = toId(modelId);
  if (id.includes('magistral')) return false;
  return (
    id.includes('mistral-medium') ||
    id.includes('mistral-small-4') ||
    id.includes('mistral-small-latest')
  );
}

/** 解析 `claude-<family>-<major>[.<minor>]` 形态（含 family 前置的中转前缀 ID）。 */
export function parseClaudeModelVersion(
  modelId: unknown,
  family: string
): [number, number] | undefined {
  const tokens = toId(modelId)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const familyIndex = tokens.indexOf(family);
  if (familyIndex < 0) return undefined;

  const parse = (value: string | undefined): number | undefined => {
    if (!value || !/^\d{1,2}$/.test(value)) return undefined;
    return Number(value);
  };
  const trailingMajor = parse(tokens[familyIndex + 1]);
  if (trailingMajor !== undefined) {
    return [trailingMajor, parse(tokens[familyIndex + 2]) ?? 0];
  }
  const leadingMajor = parse(tokens[familyIndex - 2]);
  const leadingMinor = parse(tokens[familyIndex - 1]);
  if (leadingMajor !== undefined && leadingMinor !== undefined) {
    return [leadingMajor, leadingMinor];
  }
  const adjacentMajor = parse(tokens[familyIndex - 1]);
  return adjacentMajor === undefined ? undefined : [adjacentMajor, 0];
}

/** Claude adaptive thinking 代际：Opus/Sonnet 4.6+、全系 5+、Fable/Mythos。 */
export function isClaudeAdaptiveModelId(modelId: unknown): boolean {
  const id = toId(modelId);
  if (id.includes('fable') || id.includes('mythos')) return true;
  for (const family of ['opus', 'sonnet', 'haiku']) {
    const version = parseClaudeModelVersion(id, family);
    if (!version) continue;
    const [major, minor] = version;
    if (major >= 5 || ((family === 'opus' || family === 'sonnet') && major === 4 && minor >= 6)) {
      return true;
    }
  }
  return false;
}

/** Claude 常开代际（Fable / Mythos 全系，不接受 disabled）。 */
export function isClaudeAlwaysOnModelId(modelId: unknown): boolean {
  const id = toId(modelId);
  return id.includes('fable') || id.includes('mythos');
}

/** Claude Opus 5.5：adaptive 常开，任何档位传 disabled 均 400。 */
export function isClaudeOpus55ModelId(modelId: unknown): boolean {
  const version = parseClaudeModelVersion(toId(modelId), 'opus');
  return !!version && version[0] === 5 && version[1] === 5;
}

/**
 * 全局强制思考判定（无渠道上下文时的保守兜底）。
 *
 * 注意：渠道内部应优先使用各自更精确的判定（如 isKimiK3OrLaterModelId）；
 * 本函数仅用于"身份未知"的中性路径，避免把可关闭的模型误标为强制。
 */
export function isForcedThinkingModelId(modelId: unknown): boolean {
  const id = toId(modelId);
  if (!id) return false;
  if (id.includes('gemini-3') || id.includes('gemini3')) return true;
  if (id.includes('gemini-2.5') && id.includes('pro')) return true;
  if (isClaudeAlwaysOnModelId(id)) return true;
  if (id.includes('codex') || id.includes('gpt-oss')) return true;
  if (/(?:^|[/_-])o[134](?:[.\-_/]|$)/.test(id)) return true;
  if (/gpt-5(?:\.[0-9]+)?-pro(?:[.\-_/]|$)/.test(id)) return true;
  if (isKimiK3OrLaterModelId(id)) return true;
  if (id.includes('kimi-k2.7') && id.includes('code')) return true;
  if (isLegacyKimiForcedThinkingModelId(id)) return true;
  if (isDeepSeekR1ModelId(id) || isQwenForcedThinkingModelId(id)) return true;
  if (/(?:^|[/_-])minimax-m2(?:[.\-_/]|$)/.test(id)) return true;
  return false;
}

/** Gemini 3 代际判定（思考不可关闭）。 */
export function isGemini3ModelId(modelId: unknown): boolean {
  const id = toId(modelId);
  return id.includes('gemini-3') || id.includes('gemini3');
}
