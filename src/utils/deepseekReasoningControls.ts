export type DeepSeekReasoningControlKind =
  | 'openai-effort'
  | 'v4-effort'
  | 'v32-budget-effort'
  | 'gemini-pro-effort'
  | 'gemini-flash-effort'
  | 'anthropic-adaptive-effort'
  | 'glm-effort'
  | 'grok-effort'
  | 'mistral-effort'
  | 'ernie-effort'
  // 2A Qwen 思考强度（新增）：DashScope / SiliconFlow 上 Qwen 混合思考模型
  // - qwen-budget-effort: 五档预设（低/中/高/超高/最高），映射到 thinking_budget 数值
  //   (1024/4096/16384/32768/65536)；xhigh/max 仅在部分模型文档上限内有效
  // - qwen-effort: 预留位，未来若 DashScope 开放 reasoning_effort 字符串时使用
  | 'qwen-budget-effort'
  | 'qwen-effort'
  | 'toggle-only';

export type DeepSeekReasoningOptionValue = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface DeepSeekReasoningOption {
  value: DeepSeekReasoningOptionValue;
  labelKey: string;
  defaultLabel: string;
}

export interface DeepSeekReasoningControl {
  kind: DeepSeekReasoningControlKind;
  options: DeepSeekReasoningOption[];
  /** Whether the provider/model exposes a real off state. */
  canDisable: boolean;
  /** Provider/model default when no runtime override is selected. */
  defaultValue?: DeepSeekReasoningOptionValue;
  isOfficialDeepSeek?: boolean;
}

export interface DeepSeekRuntimeReasoningControlInput {
  model?: unknown;
  modelId?: unknown;
  providerType?: unknown;
  providerScope?: unknown;
  baseUrl?: unknown;
}

export interface DeepSeekRuntimeReasoningSelectionInput {
  control: DeepSeekReasoningControl;
  enableThinking?: boolean;
  reasoningEffort?: string;
  thinkingBudget?: number;
}

export interface DeepSeekRuntimeReasoningSelection {
  enableThinking: boolean;
  reasoningEffort?: string;
  thinkingBudget?: number;
}

export const DEEPSEEK_V32_EFFORT_BUDGETS: Record<'low' | 'medium' | 'high' | 'xhigh', number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
};

const V4_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  { value: 'low', labelKey: 'settings:api.modal.deepseek.depth.low', defaultLabel: 'Low' },
  { value: 'high', labelKey: 'settings:api.modal.deepseek.depth.high', defaultLabel: 'High' },
  { value: 'max', labelKey: 'settings:api.modal.deepseek.depth.max', defaultLabel: 'Max' },
];

const OPENAI_CODEX_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  { value: 'low', labelKey: 'settings:api.modal.reasoning.effort.low', defaultLabel: 'Low' },
  { value: 'medium', labelKey: 'settings:api.modal.reasoning.effort.medium', defaultLabel: 'Medium' },
  { value: 'high', labelKey: 'settings:api.modal.reasoning.effort.high', defaultLabel: 'High' },
  { value: 'xhigh', labelKey: 'settings:api.modal.reasoning.effort.xhigh', defaultLabel: 'XHigh' },
];

/** GPT-5.6 在 xhigh 之上原生支持 max 档，不能复用 codex 档位表。 */
const GPT56_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  ...OPENAI_CODEX_EFFORT_OPTIONS,
  { value: 'max', labelKey: 'settings:api.modal.deepseek.depth.max', defaultLabel: 'Max' },
];

const LOW_HIGH_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  { value: 'low', labelKey: 'settings:api.modal.reasoning.effort.low', defaultLabel: 'Low' },
  { value: 'high', labelKey: 'settings:api.modal.reasoning.effort.high', defaultLabel: 'High' },
];

const LOW_MEDIUM_HIGH_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  { value: 'low', labelKey: 'settings:api.modal.reasoning.effort.low', defaultLabel: 'Low' },
  { value: 'medium', labelKey: 'settings:api.modal.reasoning.effort.medium', defaultLabel: 'Medium' },
  { value: 'high', labelKey: 'settings:api.modal.reasoning.effort.high', defaultLabel: 'High' },
];

const MINIMAL_LOW_MEDIUM_HIGH_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  { value: 'minimal', labelKey: 'settings:api.modal.reasoning.effort.minimal', defaultLabel: 'Minimal' },
  ...LOW_MEDIUM_HIGH_EFFORT_OPTIONS,
];

const MEDIUM_HIGH_XHIGH_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  { value: 'medium', labelKey: 'settings:api.modal.reasoning.effort.medium', defaultLabel: 'Medium' },
  { value: 'high', labelKey: 'settings:api.modal.reasoning.effort.high', defaultLabel: 'High' },
  { value: 'xhigh', labelKey: 'settings:api.modal.reasoning.effort.xhigh', defaultLabel: 'Extra High' },
];

const HIGH_ONLY_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  { value: 'high', labelKey: 'settings:api.modal.reasoning.effort.high', defaultLabel: 'High' },
];

const CLAUDE_ADAPTIVE_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  ...LOW_MEDIUM_HIGH_EFFORT_OPTIONS,
  { value: 'max', labelKey: 'settings:api.modal.deepseek.depth.max', defaultLabel: 'Max' },
];

const CLAUDE_XHIGH_ADAPTIVE_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  ...LOW_MEDIUM_HIGH_EFFORT_OPTIONS,
  { value: 'xhigh', labelKey: 'settings:api.modal.reasoning.effort.xhigh', defaultLabel: 'Extra High' },
  { value: 'max', labelKey: 'settings:api.modal.deepseek.depth.max', defaultLabel: 'Max' },
];

const GLM_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  ...MINIMAL_LOW_MEDIUM_HIGH_EFFORT_OPTIONS,
  { value: 'xhigh', labelKey: 'settings:api.modal.reasoning.effort.xhigh', defaultLabel: 'Extra High' },
  { value: 'max', labelKey: 'settings:api.modal.deepseek.depth.max', defaultLabel: 'Max' },
];

const ERNIE_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  { value: 'high', labelKey: 'settings:api.modal.reasoning.effort.high', defaultLabel: 'High' },
  { value: 'max', labelKey: 'settings:api.modal.deepseek.depth.max', defaultLabel: 'Max' },
];

// 2A Qwen 思考强度三档预设（映射到 thinking_budget 数值，单位 tokens）。
// DashScope 混合思考模型（qwen3.7-max/plus、qwen-plus/turbo/flash、qwen3.5/3.6/3.7 非 thinking 变体）
// 通过 thinking_budget 表达"思考强度"。低/中/高/超高/最高对应 1024 / 4096 / 16384 / 32768 / 65536。
//
// 注意：xhigh 和 max 仅在 qwen3.7-max / qwen3-max / qwen-plus 文档上限内有效；
// qwen-turbo / qwen-flash 等较小模型可能返回 400 错误，由 chat 错误处理提醒用户降档。
const QWEN_BUDGET_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  { value: 'low', labelKey: 'settings:api.modal.qwen.depth.low', defaultLabel: '低 (1024)' },
  { value: 'medium', labelKey: 'settings:api.modal.qwen.depth.medium', defaultLabel: '中 (4096)' },
  { value: 'high', labelKey: 'settings:api.modal.qwen.depth.high', defaultLabel: '高 (16384)' },
  { value: 'xhigh', labelKey: 'settings:api.modal.qwen.depth.xhigh', defaultLabel: '超高 (32768)' },
  { value: 'max', labelKey: 'settings:api.modal.qwen.depth.max', defaultLabel: '最高 (65536)' },
];

const V32_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  { value: 'low', labelKey: 'settings:api.modal.deepseek.depth.low', defaultLabel: 'Low' },
  { value: 'medium', labelKey: 'settings:api.modal.deepseek.depth.medium', defaultLabel: 'Medium' },
  { value: 'high', labelKey: 'settings:api.modal.deepseek.depth.high', defaultLabel: 'High' },
  { value: 'xhigh', labelKey: 'settings:api.modal.deepseek.depth.xhigh', defaultLabel: 'XHigh' },
];

const normalize = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');

export function isOfficialDeepSeekEndpoint(input: DeepSeekRuntimeReasoningControlInput): boolean {
  const baseUrl = normalize(input.baseUrl);
  if (baseUrl) {
    try {
      return new URL(baseUrl).hostname === 'api.deepseek.com';
    } catch {
      return false;
    }
  }
  return normalize(input.providerType) === 'deepseek' || normalize(input.providerScope) === 'deepseek';
}

/**
 * DeepSeek legacy 别名：`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 15:59 UTC 停用
 * （当前映射到 DeepSeek V4.1 Flash，2026-07 调研 07 要点 1）。
 * 仅保留识别以兼容存量配置；UI 应引导迁移到 `deepseek-flash` 或 `deepseek-v4-pro`。
 */
export function isDeepSeekLegacyAliasModelId(modelId: string | undefined | null): boolean {
  const lower = normalize(modelId);
  return lower === 'deepseek-chat' || lower === 'deepseek-reasoner';
}

/**
 * DeepSeek V4 一等模型：`deepseek-v4-pro` / `deepseek-v4-flash`（含 `[1m]` 等后缀变体与
 * SiliconFlow 托管的 `deepseek-ai/DeepSeek-V4-*` 形态）、V4.1 的 `deepseek-flash`
 * （2026-09-10 起官方主推型号，旧名 v4-flash / vision-exp 已路由到它）；
 * legacy 别名作为兼容识别保留。
 */
export function isDeepSeekV4ModelId(modelId: string | undefined | null): boolean {
  const lower = normalize(modelId);
  if (lower.includes('deepseek-v4') || lower.includes('deepseek-flash')) return true;
  return isDeepSeekLegacyAliasModelId(lower);
}

export function isDeepSeekV32ModelId(modelId: string | undefined | null): boolean {
  return normalize(modelId).includes('deepseek-v3.2');
}

export function isOpenAiReasoningModelId(modelId: string | undefined | null): boolean {
  const lower = normalize(modelId);
  if (!lower) return false;
  const isGpt5Chat = /(?:^|[/_-])gpt-5(?:\.\d+)?-chat(?:[.\-_/]|$)/.test(lower);
  return (
    (!isGpt5Chat && /(?:^|[/_-])gpt-5(?:[.\-_/]|$)/.test(lower)) ||
    /(?:^|[/_-])o[134](?:[.\-_/]|$)/.test(lower) ||
    /(?:^|[/_-])gpt-oss(?:[.\-_/]|$)/.test(lower) ||
    /(?:^|[/_-])codex-mini(?:[.\-_/]|$)/.test(lower)
  );
}

function isGemini3ModelId(modelId: string): boolean {
  return modelId.includes('gemini-3') || modelId.includes('gemini3');
}

function isGemini3FlashModelId(modelId: string): boolean {
  return isGemini3ModelId(modelId) && modelId.includes('flash');
}

function getGemini3DefaultEffort(modelId: string): DeepSeekReasoningOptionValue {
  // flash-lite 必须先于 gemini-3.5-flash 匹配：
  // "gemini-3.5-flash-lite" 包含子串 "gemini-3.5-flash"，
  // 若顺序颠倒会被误判为 Flash 默认 "medium"（与后端 gemini.rs 对齐，覆盖 3.5/3.1 lite）
  if (modelId.includes('flash-lite')) return 'minimal';
  if (modelId.includes('gemini-3.5-flash')) return 'medium';
  if (modelId.includes('gemini-3-flash')) return 'high';
  return modelId.includes('flash') ? 'low' : 'high';
}

function parseNamedModelVersion(modelId: string, family: string): [number, number] | undefined {
  const tokens = modelId
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const familyIndex = tokens.indexOf(family);
  if (familyIndex < 0) return undefined;

  const parseVersion = (value: string | undefined): number | undefined => {
    if (!value || !/^\d{1,2}$/.test(value)) return undefined;
    return Number(value);
  };
  const trailingMajor = parseVersion(tokens[familyIndex + 1]);
  if (trailingMajor !== undefined) {
    return [trailingMajor, parseVersion(tokens[familyIndex + 2]) ?? 0];
  }
  const leadingMajor = parseVersion(tokens[familyIndex - 2]);
  const leadingMinor = parseVersion(tokens[familyIndex - 1]);
  if (leadingMajor !== undefined && leadingMinor !== undefined) {
    return [leadingMajor, leadingMinor];
  }
  const adjacentMajor = parseVersion(tokens[familyIndex - 1]);
  return adjacentMajor === undefined ? undefined : [adjacentMajor, 0];
}

function isClaudeAdaptiveModelId(modelId: string): boolean {
  if (modelId.includes('fable') || modelId.includes('mythos')) return true;
  for (const family of ['opus', 'sonnet', 'haiku']) {
    const version = parseNamedModelVersion(modelId, family);
    if (!version) continue;
    const [major, minor] = version;
    if (
      major >= 5 ||
      ((family === 'opus' || family === 'sonnet') && major === 4 && minor >= 6)
    ) return true;
  }
  return false;
}

function isClaudeXHighEffortModelId(modelId: string): boolean {
  for (const family of ['opus', 'sonnet', 'fable', 'mythos']) {
    const version = parseNamedModelVersion(modelId, family);
    if (!version) continue;
    const [major, minor] = version;
    if (family === 'opus' && major === 4 && (minor === 7 || minor === 8)) return true;
    if (family === 'sonnet' && major === 5) return true;
    if ((family === 'fable' || family === 'mythos') && major === 5) return true;
  }
  return false;
}

function isClaudeAlwaysOnModelId(modelId: string): boolean {
  return modelId.includes('fable') || modelId.includes('mythos');
}

function parseVersionAfterPrefix(modelId: string, prefix: string): [number, number] | undefined {
  const match = modelId.match(new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[-]?(\\d+)(?:[.-](\\d{1,2}))?`));
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0)];
}

function isGlm52OrLaterModelId(modelId: string): boolean {
  const version = parseVersionAfterPrefix(modelId, 'glm');
  return !!version && (version[0] > 5 || (version[0] === 5 && version[1] >= 2));
}

function isGrok43OrLaterModelId(modelId: string): boolean {
  if (modelId.includes('non-reasoning')) return false;
  if (modelId === 'grok-latest' || modelId.endsWith('/grok-latest')) return true;
  const version = parseVersionAfterPrefix(modelId, 'grok');
  return !!version && (version[0] > 4 || (version[0] === 4 && version[1] >= 3));
}

function isGrokMultiAgentModelId(modelId: string): boolean {
  return /grok-4[.-]20[\w.-]*multi-agent/.test(modelId);
}

function isMistralEffortModelId(modelId: string): boolean {
  if (modelId.includes('magistral')) return false;
  return modelId.includes('mistral-medium') || modelId.includes('mistral-small-4') || modelId.includes('mistral-small-latest');
}

function isErnieEffortModelId(modelId: string): boolean {
  return modelId.includes('ernie-5') || modelId.includes('ernie-x1');
}

function isQwenForcedThinkingModelId(modelId: string): boolean {
  if (modelId.includes('qwq')) return true;
  if (/qwen3[.-]7-max-preview(?:[-_/]|$)/.test(modelId)) return true;
  if (/qwen3[.-]7-max-(?:2026-05-17|20260517)(?:[-_/]|$)/.test(modelId)) return true;
  return modelId.includes('qwen3') && /(?:^|[-_/])thinking(?:[-_/]|$)/.test(modelId);
}

// 2A：识别"Qwen 混合思考"模型 —— 用户可以通过 enable_thinking 开关切换思考模式，
// 并可通过 thinking_budget 数值表达"思考强度"。
// 与 isQwenForcedThinkingModelId 互补：这里返回 true 的模型可以被关闭思考。
// 覆盖：qwen3.5/3.6/3.7 非 thinking 变体、qwen-plus/turbo/flash（qwen3 商业家族）、
// qwen3-max 非 preview 变体。vendor 前缀（Qwen/Qwen3-…）也算。
function isQwenHybridThinkingModelId(modelId: string): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  // 强制思考模型不算 hybrid（它们没有关闭开关）
  if (isQwenForcedThinkingModelId(id)) return false;
  // coder 变体不支持思考
  if (id.includes('coder')) return false;
  // qwen3-max 非 preview（preview 走 forced）
  if (/^qwen3?-max/.test(id) && !id.includes('preview')) return true;
  // qwen3.5/3.6/3.7 非 thinking 变体（含 vendor 前缀 Qwen/Qwen3-…）
  const isVendorQwen3 = /^qwen\/qwen3[-.]/.test(id);
  if (id.startsWith('qwen3') || isVendorQwen3) {
    if (id.includes('thinking')) return false; // forced
    if (id.includes('instruct')) return false; // instruct 通常无思考
    if (/qwen3[.-][5-7]/.test(id)) return true;
    if (id.includes('preview')) return false; // preview 走 forced
    return true;
  }
  // qwen-plus / qwen-turbo / qwen-flash（qwen3 商业家族）
  if (/^qwen-plus/.test(id) || /^qwen-turbo/.test(id) || /^qwen-flash/.test(id)) return true;
  return false;
}

function isLegacyKimiForcedThinkingModelId(modelId: string): boolean {
  return (
    modelId.includes('kimi-k2-thinking') ||
    modelId.includes('kimi-thinking-preview') ||
    (modelId.includes('kimi-vl-') && modelId.includes('thinking'))
  );
}

/**
 * Kimi K3+：后端 moonshot 适配器固定发送 `reasoning_effort: "max"`，推理不可关闭
 * （registry quirk：不得发送 K2.x thinking 对象）。前端必须视为 forced（canDisable=false）。
 *
 * 版本解析与后端 `MoonshotAdapter::parse_k_version` 对齐：取模型名中首个
 * `k<major>` 版本号，且 `k` 前必须是开头或非字母数字边界（避免 `grok`、`128k`
 * 之类误判）。后端适配器仅在 moonshot 供应商下生效，前端没有供应商上下文，
 * 因此额外要求模型名包含 kimi/moonshot。
 */
function isKimiK3OrLaterModelId(modelId: string): boolean {
  if (!modelId.includes('kimi') && !modelId.includes('moonshot')) return false;
  const match = modelId.match(/(?:^|[^a-z0-9])k(\d+)/);
  return !!match && Number(match[1]) >= 3;
}

function isForcedThinkingModelId(modelId: string): boolean {
  if (
    isGemini3ModelId(modelId) ||
    (modelId.includes('gemini-2.5') && modelId.includes('pro')) ||
    isClaudeAlwaysOnModelId(modelId)
  ) return true;
  if (
    modelId.includes('codex') ||
    modelId.includes('gpt-oss') ||
    /(?:^|[/_-])o[134](?:[.\-_/]|$)/.test(modelId) ||
    /gpt-5(?:\.[0-9]+)?-pro(?:[.\-_/]|$)/.test(modelId)
  ) return true;
  if (
    isKimiK3OrLaterModelId(modelId) ||
    (modelId.includes('kimi-k2.7') && modelId.includes('code')) ||
    isLegacyKimiForcedThinkingModelId(modelId)
  ) return true;
  if (modelId.includes('deepseek-r1') || isQwenForcedThinkingModelId(modelId)) return true;
  return /(?:^|[/_-])minimax-m2(?:[.\-_/]|$)/.test(modelId);
}

function resolveOpenAiEffortControl(
  modelId: string,
  providerForcesThinking = false
): DeepSeekReasoningControl {
  const finalize = (control: DeepSeekReasoningControl): DeepSeekReasoningControl =>
    providerForcesThinking ? { ...control, canDisable: false } : control;

  if (modelId.includes('gpt-oss')) {
    return finalize({ kind: 'openai-effort', options: LOW_MEDIUM_HIGH_EFFORT_OPTIONS, canDisable: false });
  }
  if (modelId.includes('codex')) {
    const isLegacyMini = modelId.includes('codex-mini') && !/gpt-5\.[2-9]/.test(modelId);
    return finalize({
      kind: 'openai-effort',
      options: isLegacyMini ? LOW_MEDIUM_HIGH_EFFORT_OPTIONS : OPENAI_CODEX_EFFORT_OPTIONS,
      canDisable: false,
    });
  }
  if (/(?:^|[/_-])o[134](?:[.\-_/]|$)/.test(modelId)) {
    return finalize({
      kind: 'openai-effort',
      options: modelId.includes('-pro') ? HIGH_ONLY_EFFORT_OPTIONS : LOW_MEDIUM_HIGH_EFFORT_OPTIONS,
      canDisable: false,
    });
  }
  if (/gpt-5\.5-pro(?:[.\-_/]|$)/.test(modelId)) {
    return finalize({ kind: 'openai-effort', options: MEDIUM_HIGH_XHIGH_EFFORT_OPTIONS, canDisable: false });
  }
  if (/gpt-5(?:\.[0-9]+)?-pro(?:[.\-_/]|$)/.test(modelId)) {
    return finalize({ kind: 'openai-effort', options: HIGH_ONLY_EFFORT_OPTIONS, canDisable: false });
  }
  if (/gpt-5(?!\.\d)(?:-(?:mini|nano))?(?:[.\-_/]|$)/.test(modelId)) {
    return finalize({
      kind: 'openai-effort',
      options: MINIMAL_LOW_MEDIUM_HIGH_EFFORT_OPTIONS,
      canDisable: false,
    });
  }
  if (/gpt-5\.6(?:[.\-_/]|$)/.test(modelId)) {
    return finalize({
      kind: 'openai-effort',
      options: GPT56_EFFORT_OPTIONS,
      canDisable: true,
    });
  }
  if (/gpt-5\.[45](?:[.\-_/]|$)/.test(modelId)) {
    return finalize({
      kind: 'openai-effort',
      options: OPENAI_CODEX_EFFORT_OPTIONS,
      canDisable: true,
    });
  }
  if (/gpt-5\.[1-3](?:[.\-_/]|$)/.test(modelId)) {
    return finalize({
      kind: 'openai-effort',
      options: modelId.includes('5.1') ? LOW_MEDIUM_HIGH_EFFORT_OPTIONS : OPENAI_CODEX_EFFORT_OPTIONS,
      canDisable: true,
    });
  }

  return finalize({
    kind: 'openai-effort',
    options: OPENAI_CODEX_EFFORT_OPTIONS,
    canDisable: !isForcedThinkingModelId(modelId),
  });
}

export function deepSeekV32EffortToBudget(effort: string | undefined | null): number | undefined {
  const normalized = normalize(effort);
  if (normalized === 'max') return DEEPSEEK_V32_EFFORT_BUDGETS.xhigh;
  if (normalized in DEEPSEEK_V32_EFFORT_BUDGETS) {
    return DEEPSEEK_V32_EFFORT_BUDGETS[normalized as keyof typeof DEEPSEEK_V32_EFFORT_BUDGETS];
  }
  return undefined;
}

export function deepSeekV32BudgetToEffort(budget: number | undefined | null): 'low' | 'medium' | 'high' | 'xhigh' {
  if (typeof budget !== 'number' || !Number.isFinite(budget)) return 'medium';
  if (budget <= DEEPSEEK_V32_EFFORT_BUDGETS.low) return 'low';
  if (budget <= DEEPSEEK_V32_EFFORT_BUDGETS.medium) return 'medium';
  if (budget <= DEEPSEEK_V32_EFFORT_BUDGETS.high) return 'high';
  return 'xhigh';
}

// 2A Qwen 思考强度预设（单位 tokens）。
// DashScope 混合思考模型通过 thinking_budget 表达"思考强度"。
//
// 档位依据：
// - low/medium/high 是 2A 引入的保守档，兼容所有 Qwen 混合思考模型
// - xhigh (32768) 匹配 qwen-plus 文档上限
// - max (65536) 匹配 qwen3.7-max / qwen3-max 文档上限
//
// 注意：部分模型（如 qwen-turbo / qwen-flash）文档上限低于 max，
// API 会返回 400 错误。前端允许选择这两档，但需要在错误发生后提醒
// 用户降到 high 或更低（见 chat 错误处理）。
const QWEN_EFFORT_BUDGETS = {
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 32768,
  max: 65536,
} as const;

export function qwenEffortToBudget(effort: string | undefined | null): number {
  const normalized = normalize(effort);
  if (normalized === 'low') return QWEN_EFFORT_BUDGETS.low;
  if (normalized === 'high') return QWEN_EFFORT_BUDGETS.high;
  if (normalized === 'xhigh') return QWEN_EFFORT_BUDGETS.xhigh;
  if (normalized === 'max') return QWEN_EFFORT_BUDGETS.max;
  return QWEN_EFFORT_BUDGETS.medium;
}

export function qwenBudgetToEffort(budget: number | undefined | null): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (typeof budget !== 'number' || !Number.isFinite(budget)) return 'medium';
  if (budget <= QWEN_EFFORT_BUDGETS.low) return 'low';
  if (budget <= QWEN_EFFORT_BUDGETS.medium) return 'medium';
  if (budget <= QWEN_EFFORT_BUDGETS.high) return 'high';
  if (budget <= QWEN_EFFORT_BUDGETS.xhigh) return 'xhigh';
  return 'max';
}

export function normalizeDeepSeekV4Effort(
  effort: string | undefined | null,
  isOfficial = false,
): 'low' | 'high' | 'max' {
  const normalized = normalize(effort);
  // The official xhigh alias is high; hosted deployments keep their existing max alias.
  if (normalized === 'minimal' || normalized === 'low') return 'low';
  if (normalized === 'xhigh') return isOfficial ? 'high' : 'max';
  if (normalized === 'max' || normalized === 'ultra') return 'max';
  return 'high';
}

export function resolveDeepSeekReasoningControl(
  modelId: string | undefined | null,
  supportsReasoningEffort: boolean
): DeepSeekReasoningControl {
  if (isOpenAiReasoningModelId(modelId)) {
    return resolveOpenAiEffortControl(normalize(modelId));
  }
  if (supportsReasoningEffort || isDeepSeekV4ModelId(modelId)) {
    return { kind: 'v4-effort', options: V4_EFFORT_OPTIONS, canDisable: true };
  }
  if (isDeepSeekV32ModelId(modelId)) {
    return { kind: 'v32-budget-effort', options: V32_EFFORT_OPTIONS, canDisable: true };
  }
  return { kind: 'toggle-only', options: [], canDisable: true };
}

export function resolveDeepSeekRuntimeReasoningControl(
  input: DeepSeekRuntimeReasoningControlInput
): DeepSeekReasoningControl {
  const model = normalize(input.model) || normalize(input.modelId);
  const providerType = normalize(input.providerType);
  const providerScope = normalize(input.providerScope);
  const baseUrl = normalize(input.baseUrl);
  const providerForcesThinking = providerType === 'openai_codex' || providerScope === 'openai_codex';
  const isSiliconFlow =
    providerType === 'siliconflow' ||
    providerScope === 'siliconflow' ||
    baseUrl.includes('siliconflow.cn') ||
    baseUrl.includes('siliconflow.com');
  if (isDeepSeekV4ModelId(model)) {
    return {
      kind: 'v4-effort', options: V4_EFFORT_OPTIONS, canDisable: true,
      isOfficialDeepSeek: isOfficialDeepSeekEndpoint(input),
    };
  }
  // 2A：Qwen 混合思考模型优先于 SiliconFlow 分支判定 ——
  // 即使用户把 Qwen 挂在 SiliconFlow 上，思考强度档位也用 Qwen 自己的（1024/4096/16384）
  // 而不是 DeepSeek V3.2 的（2048/8192/32768）。
  if (isQwenHybridThinkingModelId(model)) {
    return {
      kind: 'qwen-budget-effort',
      options: QWEN_BUDGET_EFFORT_OPTIONS,
      canDisable: true,
      defaultValue: 'medium',
    };
  }
  if (isSiliconFlow) {
    return {
      kind: 'v32-budget-effort',
      options: V32_EFFORT_OPTIONS,
      canDisable: !isForcedThinkingModelId(model),
    };
  }
  if (isOpenAiReasoningModelId(model)) {
    return resolveOpenAiEffortControl(model, providerForcesThinking);
  }
  if (isDeepSeekV32ModelId(model)) {
    return { kind: 'v32-budget-effort', options: V32_EFFORT_OPTIONS, canDisable: true };
  }
  if (isGemini3ModelId(model)) {
    const isFlash = isGemini3FlashModelId(model);
    return {
      kind: isFlash ? 'gemini-flash-effort' : 'gemini-pro-effort',
      options: isFlash ? MINIMAL_LOW_MEDIUM_HIGH_EFFORT_OPTIONS : LOW_HIGH_EFFORT_OPTIONS,
      canDisable: false,
      defaultValue: getGemini3DefaultEffort(model),
    };
  }
  if (isClaudeAdaptiveModelId(model)) {
    return {
      kind: 'anthropic-adaptive-effort',
      options: isClaudeXHighEffortModelId(model)
        ? CLAUDE_XHIGH_ADAPTIVE_EFFORT_OPTIONS
        : CLAUDE_ADAPTIVE_EFFORT_OPTIONS,
      canDisable: !isClaudeAlwaysOnModelId(model),
    };
  }
  if (isGlm52OrLaterModelId(model)) {
    return { kind: 'glm-effort', options: GLM_EFFORT_OPTIONS, canDisable: true };
  }
  if (isGrokMultiAgentModelId(model)) {
    return { kind: 'grok-effort', options: OPENAI_CODEX_EFFORT_OPTIONS, canDisable: false };
  }
  if (isGrok43OrLaterModelId(model)) {
    return { kind: 'grok-effort', options: LOW_MEDIUM_HIGH_EFFORT_OPTIONS, canDisable: true };
  }
  if (isMistralEffortModelId(model)) {
    return { kind: 'mistral-effort', options: LOW_MEDIUM_HIGH_EFFORT_OPTIONS, canDisable: true };
  }
  if (isErnieEffortModelId(model)) {
    return { kind: 'ernie-effort', options: ERNIE_EFFORT_OPTIONS, canDisable: true };
  }
  return {
    kind: 'toggle-only',
    options: [],
    canDisable: !providerForcesThinking && !isForcedThinkingModelId(model),
  };
}

export function resolveDeepSeekRuntimeReasoningSelection(
  input: DeepSeekRuntimeReasoningSelectionInput
): DeepSeekRuntimeReasoningSelection {
  const enableThinking = input.control.canDisable ? input.enableThinking ?? true : true;

  if (input.control.kind === 'openai-effort') {
    const normalizedEffort = normalize(input.reasoningEffort);
    const allowed = input.control.options.map((option) => option.value);
    const fallback = allowed.includes('medium') ? 'medium' : allowed[0];
    const effort = allowed.includes(normalizedEffort as DeepSeekReasoningOptionValue)
      ? normalizedEffort as DeepSeekReasoningOptionValue
      : fallback;

    return {
      enableThinking,
      reasoningEffort: effort,
      thinkingBudget: undefined,
    };
  }

  if (input.control.kind === 'v4-effort') {
    return {
      enableThinking,
      reasoningEffort: normalizeDeepSeekV4Effort(
        input.reasoningEffort ?? deepSeekV32BudgetToEffort(input.thinkingBudget),
        input.control.isOfficialDeepSeek,
      ),
      thinkingBudget: undefined,
    };
  }

  if (input.control.kind === 'v32-budget-effort') {
    const normalizedEffort = normalize(input.reasoningEffort);
    const effort =
      normalizedEffort === 'low' ||
      normalizedEffort === 'medium' ||
      normalizedEffort === 'high' ||
      normalizedEffort === 'xhigh' ||
      normalizedEffort === 'max'
        ? normalizedEffort
        : deepSeekV32BudgetToEffort(input.thinkingBudget);
    const v32Effort = effort === 'max' ? 'xhigh' : effort;

    return {
      enableThinking,
      reasoningEffort: v32Effort,
      thinkingBudget: deepSeekV32EffortToBudget(v32Effort),
    };
  }

  // 2A Qwen 思考强度：low/medium/high/xhigh/max → thinking_budget (1024/4096/16384/32768/65536)
  // 与 v32-budget-effort 类似，但 budget 档位不同；reasoningEffort 字段保留供 UI 显示。
  // 注意：xhigh 和 max 仅在部分 Qwen 模型（qwen3.7-max / qwen3-max / qwen-plus）文档上限内有效；
  // qwen-turbo / qwen-flash 等较小模型可能返回 400 错误，由 chat 错误处理提醒用户降档。
  if (input.control.kind === 'qwen-budget-effort') {
    const normalizedEffort = normalize(input.reasoningEffort);
    const effort: DeepSeekReasoningOptionValue =
      normalizedEffort === 'low' ||
      normalizedEffort === 'medium' ||
      normalizedEffort === 'high' ||
      normalizedEffort === 'xhigh' ||
      normalizedEffort === 'max'
        ? (normalizedEffort as DeepSeekReasoningOptionValue)
        : (input.control.defaultValue ?? 'medium');
    return {
      enableThinking,
      reasoningEffort: effort,
      thinkingBudget: qwenEffortToBudget(effort),
    };
  }

  if (input.control.kind !== 'toggle-only') {
    const normalizedEffort = normalize(input.reasoningEffort);
    const allowed = input.control.options.map((option) => option.value);
    const fallbackByKind: Partial<Record<DeepSeekReasoningControlKind, DeepSeekReasoningOptionValue>> = {
      'gemini-pro-effort': 'high',
      'gemini-flash-effort': 'low',
      'anthropic-adaptive-effort': 'high',
      'glm-effort': 'max',
      'grok-effort': 'low',
      'mistral-effort': 'low',
      'ernie-effort': 'high',
    };
    const fallback =
      input.control.defaultValue ??
      fallbackByKind[input.control.kind] ??
      (allowed.includes('medium') ? 'medium' : allowed[0]);
    const effort = allowed.includes(normalizedEffort as DeepSeekReasoningOptionValue)
      ? normalizedEffort as DeepSeekReasoningOptionValue
      : fallback;

    return {
      enableThinking,
      reasoningEffort: effort,
      thinkingBudget: undefined,
    };
  }

  return {
    enableThinking,
    reasoningEffort: undefined,
    thinkingBudget: undefined,
  };
}
