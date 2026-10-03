// 渠道并行思考强度（方案 D + 方案 E，2026-10-03）。
//
// 设计：每个渠道（= get_adapter 命中的适配器）一个独立的 resolve 函数，各自
// 拥有档位表、默认档、canDisable 与强制思考名单；渠道之间零引用、互不覆盖。
// 注册表（registry.ts）按 resolvedAdapterId 做 O(1) 字典查找。
//
// 方案 E：家族识别与子型号识别全部改为**包含匹配**——
// `codex666-glm-5.3-flash` 包含 "glm" → 智谱家族，包含 "5.3" → (5,3) 版本；
// 中转站给模型 ID 加的任意前缀不再影响匹配。每个渠道先做家族门控
//（matchModelFamily），再做渠道内子型号判定。
//
// 2026-10-03 官方文档调研结论（docs/dev/reasoning-intensity-refactor-plan §8/§10）：
// - Qwen3.8 系（max/flash/27b/omni）顶层 reasoning_effort（low/medium/xhigh，
//   默认 xhigh），与 thinking_budget 互斥；
// - GLM-5.3/5.3-Flash/FlashX 强制思考不可关闭，effort 仅 low/high/max；
// - Kimi K3 effort 开放 low/high/max（默认 max），始终思考；
// - Grok 4.5+ 不可关闭，xhigh 仅 4.6+（4.5 静默按 high）；
// - gpt-6 系列已出（sol/luna/astra），reasoning_effort 仍是控制参数。

import {
  CLAUDE_ADAPTIVE_EFFORT_OPTIONS,
  CLAUDE_XHIGH_ADAPTIVE_EFFORT_OPTIONS,
  ERNIE_EFFORT_OPTIONS,
  GPT56_EFFORT_OPTIONS,
  GLM_EFFORT_OPTIONS,
  LOW_HIGH_EFFORT_OPTIONS,
  LOW_MEDIUM_HIGH_EFFORT_OPTIONS,
  MINIMAL_LOW_MEDIUM_HIGH_EFFORT_OPTIONS,
  OPENAI_CODEX_EFFORT_OPTIONS,
  QWEN_BUDGET_EFFORT_OPTIONS,
  V32_EFFORT_OPTIONS,
  V4_EFFORT_OPTIONS,
  isClaudeAdaptiveModelId,
  isClaudeXHighEffortModelId,
  isClaudeAlwaysOnModelId,
  isDeepSeekV4ModelId,
  isForcedThinkingModelId,
  isKimiK3OrLaterModelId,
  isLegacyKimiForcedThinkingModelId,
  isMistralEffortModelId,
  isOfficialDeepSeekEndpoint,
  isQwenForcedThinkingModelId,
  resolveOpenAiEffortControl,
  type DeepSeekReasoningControl,
  type DeepSeekReasoningOption,
} from '../deepseekReasoningControls';
import {
  extractModelVersion,
  isGpt6ModelId,
  matchModelFamily,
  matchesOpenAiOSeries,
  type ModelFamily,
} from './modelFamily';

/** 渠道解析入参；adapterId 为 get_adapter 解析结果（后端下发 / 设置页显式选择）。
 *  字段按 unknown 接收（与旧 DeepSeekRuntimeReasoningControlInput 一致，store 透传值
 *  可能缺类型），渠道内部统一 normalize。 */
export interface ReasoningChannelInput {
  model?: unknown;
  modelId?: unknown;
  adapterId?: unknown;
  providerType?: unknown;
  providerScope?: unknown;
  baseUrl?: unknown;
  /** 模型配置的 supportsReasoning（generic 渠道的思考强度开关依据）。 */
  supportsReasoning?: unknown;
}

const normalize = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const isSiliconFlowHost = (input: ReasoningChannelInput): boolean =>
  normalize(input.providerType) === 'siliconflow' ||
  normalize(input.providerScope) === 'siliconflow' ||
  normalize(input.baseUrl).includes('siliconflow.cn') ||
  normalize(input.baseUrl).includes('siliconflow.com');

/** 渠道入口统一做的家族门控：模型 ID 必须包含本家族关键词（包含匹配）。 */
function gate(input: ReasoningChannelInput, family: ModelFamily): string | null {
  const model = normalize(input.model) || normalize(input.modelId);
  if (!model) return null;
  return matchModelFamily(model) === family ? model : null;
}

// ── Qwen 渠道 ────────────────────────────────────────────────────────────

// SiliconFlow 宿主变体：官方文档 thinking_budget 范围 128–32768（2026-10 调研 §8），
// 不提供 DashScope 的 65536/262144 两档；xhigh 即宿主上限 32768。
const QWEN_SILICONFLOW_BUDGET_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  { value: 'low', labelKey: 'settings:api.modal.qwen.depth.low', defaultLabel: '低 (1024)' },
  { value: 'medium', labelKey: 'settings:api.modal.qwen.depth.medium', defaultLabel: '中 (4096)' },
  { value: 'high', labelKey: 'settings:api.modal.qwen.depth.high', defaultLabel: '高 (16384)' },
  { value: 'xhigh', labelKey: 'settings:api.modal.qwen.depth.xhigh_sf', defaultLabel: '超高 (32768)' },
];

// Qwen3.8 系（max/flash/27b/omni，2026-10 千问AI平台官方文档）：顶层
// reasoning_effort 档位，可选 low/medium/xhigh（默认 xhigh）；
// high/max 由服务端映射为 xhigh，none 表示关闭思考（canDisable）。
// thinking_budget 虽仍文档化，但按产品规则降为兜底（未配置 effort 时由
// 后端 qwen 适配器兜底发送），渠道档位只表达 effort。
const QWEN38_EFFORT_OPTIONS: DeepSeekReasoningOption[] = [
  { value: 'low', labelKey: 'settings:api.modal.qwen.depth38.low', defaultLabel: '低' },
  { value: 'medium', labelKey: 'settings:api.modal.qwen.depth38.medium', defaultLabel: '中' },
  { value: 'xhigh', labelKey: 'settings:api.modal.qwen.depth38.xhigh', defaultLabel: '超高 (默认)' },
];

/** qwen3.8 系（含 vendor 前缀/中转前缀，包含匹配）。 */
function isQwen38ModelId(model: string): boolean {
  return model.includes('qwen3.8');
}

/** qwen3.8-2.4t-a95b 等纯推理型号：始终思考不可关闭。 */
function isQwen38PureThinkingModelId(model: string): boolean {
  return model.includes('qwen3.8') && model.includes('2.4t');
}

/**
 * Qwen 混合思考模型（3.7 及更早）：包含式版本 (3,5)~(3,7) 的非 thinking/instruct
 * 变体、qwen-plus/turbo/flash 商业系、qwen3-max 非 preview。
 * （3.8 系已先行分流到 qwen-effort，不进入本判定。）
 */
function isQwenHybridModelId(model: string): boolean {
  if (model.includes('coder')) return false;
  if (model.includes('qwen-plus') || model.includes('qwen-turbo') || model.includes('qwen-flash')) {
    return true;
  }
  const version = extractModelVersion(model);
  if (version && version[0] === 3) {
    const [, minor] = version;
    if (model.includes('thinking') || model.includes('instruct')) return false;
    // 3.5/3.6/3.7 混合思考；3.8 系已在上游分流到 effort 档位
    if (minor >= 5 && minor <= 7) return true;
    return false;
  }
  // qwen3-max 非 preview（无 x.y 版本号的 3 代 max）
  if (model.includes('qwen3-max') && !model.includes('preview')) return true;
  return false;
}

export function resolveQwenChannel(input: ReasoningChannelInput): DeepSeekReasoningControl | null {
  const model = gate(input, 'qwen');
  if (!model) return null;

  // 强制思考：QwQ / qwen3.7-max-preview（含日期变体）/ qwen3 *-thinking /
  // qwen3.8 纯推理型号。
  if (isQwenForcedThinkingModelId(model) || isQwen38PureThinkingModelId(model)) {
    return { kind: 'toggle-only', options: [], canDisable: false };
  }

  // Qwen3.8 系（max/flash/27b/omni）：reasoning_effort 档位，不发 thinking_budget。
  if (isQwen38ModelId(model)) {
    return {
      kind: 'qwen-effort',
      options: QWEN38_EFFORT_OPTIONS,
      canDisable: true,
      defaultValue: 'xhigh',
    };
  }

  // 混合思考（3.7 及更早）。SiliconFlow 宿主用宿主档位表（上限 32768）；
  // 这些型号官方文档未开放 reasoning_effort，仍走 thinking_budget。
  if (isQwenHybridModelId(model)) {
    const siliconflow = isSiliconFlowHost(input);
    return {
      kind: 'qwen-budget-effort',
      options: siliconflow ? QWEN_SILICONFLOW_BUDGET_EFFORT_OPTIONS : QWEN_BUDGET_EFFORT_OPTIONS,
      canDisable: true,
      defaultValue: 'medium',
    };
  }

  return null;
}

// ── OpenAI 渠道（gpt-5.x / gpt-6 系 / o 系列 / codex / gpt-oss）───────────

export function resolveOpenAiChannel(input: ReasoningChannelInput): DeepSeekReasoningControl | null {
  const model = gate(input, 'openai');
  if (!model) return null;
  // gpt-6 系（sol/luna/astra）：reasoning_effort 仍是控制参数（2026-10 调研），
  // 档位按 gpt-5.6 同构处理（low..max）。
  if (isGpt6ModelId(model)) {
    return { kind: 'openai-effort', options: GPT56_EFFORT_OPTIONS, canDisable: true };
  }
  // o 系列保持词边界特例（裸包含误报率过高）；gpt-5.x/codex/gpt-oss 的
  // 边界正则在中转前缀 ID 上同样命中（包含语义）。
  if (matchesOpenAiOSeries(model) || model.includes('gpt-5') || model.includes('gpt-oss') || model.includes('codex')) {
    return resolveOpenAiEffortControl(model);
  }
  return null;
}

// ── DeepSeek 渠道 ────────────────────────────────────────────────────────

export function resolveDeepSeekChannel(input: ReasoningChannelInput): DeepSeekReasoningControl | null {
  const model = gate(input, 'deepseek');
  if (!model) return null;
  if (isDeepSeekV4ModelId(model)) {
    return {
      kind: 'v4-effort',
      options: V4_EFFORT_OPTIONS,
      canDisable: true,
      isOfficialDeepSeek: isOfficialDeepSeekEndpoint(input),
    };
  }
  if (model.includes('deepseek-v3.2')) {
    return { kind: 'v32-budget-effort', options: V32_EFFORT_OPTIONS, canDisable: true };
  }
  if (isForcedThinkingModelId(model)) {
    // DeepSeek-R1 等：思考不可关，无档位。
    return { kind: 'toggle-only', options: [], canDisable: false };
  }
  return null;
}

// ── Gemini 渠道 ──────────────────────────────────────────────────────────

function getGemini3DefaultEffort(modelId: string): DeepSeekReasoningOption['value'] {
  // flash-lite 必须先于 flash 匹配（子串包含关系，与后端 gemini.rs 对齐）。
  if (modelId.includes('flash-lite')) return 'minimal';
  // 2026-10 官方默认表：3.8-flash/3.7-flash/3.5-flash 默认 medium（动态）。
  if (/gemini-3[.-][5-8][.-]?flash/.test(modelId)) return 'medium';
  if (modelId.includes('gemini-3-flash')) return 'high';
  return modelId.includes('flash') ? 'low' : 'high';
}

export function resolveGeminiChannel(input: ReasoningChannelInput): DeepSeekReasoningControl | null {
  const model = gate(input, 'gemini');
  if (!model) return null;
  if (model.includes('gemini-3') || model.includes('gemini3')) {
    const isFlash = model.includes('flash');
    return {
      kind: isFlash ? 'gemini-flash-effort' : 'gemini-pro-effort',
      options: isFlash ? MINIMAL_LOW_MEDIUM_HIGH_EFFORT_OPTIONS : LOW_HIGH_EFFORT_OPTIONS,
      canDisable: false,
      defaultValue: getGemini3DefaultEffort(model),
    };
  }
  if (model.includes('gemini-2.5')) {
    return { kind: 'gemini-flash-effort', options: MINIMAL_LOW_MEDIUM_HIGH_EFFORT_OPTIONS, canDisable: true };
  }
  return null;
}

// ── Claude 渠道 ──────────────────────────────────────────────────────────

export function resolveClaudeChannel(input: ReasoningChannelInput): DeepSeekReasoningControl | null {
  const model = gate(input, 'claude');
  if (!model || !isClaudeAdaptiveModelId(model)) return null;
  return {
    kind: 'anthropic-adaptive-effort',
    options: isClaudeXHighEffortModelId(model)
      ? CLAUDE_XHIGH_ADAPTIVE_EFFORT_OPTIONS
      : CLAUDE_ADAPTIVE_EFFORT_OPTIONS,
    canDisable: !isClaudeAlwaysOnModelId(model),
  };
}

// ── 智谱 GLM 渠道 ────────────────────────────────────────────────────────

export function resolveZhipuChannel(input: ReasoningChannelInput): DeepSeekReasoningControl | null {
  const model = gate(input, 'zhipu');
  if (!model) return null;
  // GLM-5.3/5.3-Flash/FlashX：强制思考不可关闭，effort 仅 low/high/max
  //（2026-10 官方文档；其余取值直接报错）。
  if (model.includes('5.3')) {
    return {
      kind: 'glm-effort',
      options: [
        { value: 'low', labelKey: 'settings:api.modal.reasoning.effort.low', defaultLabel: 'Low' },
        { value: 'high', labelKey: 'settings:api.modal.reasoning.effort.high', defaultLabel: 'High' },
        { value: 'max', labelKey: 'settings:api.modal.deepseek.depth.max', defaultLabel: 'Max' },
      ],
      canDisable: false,
      defaultValue: 'max',
    };
  }
  // GLM-5.2 及以上（包含式版本提取，不锚定前缀）。
  const version = extractModelVersion(model);
  if (version && (version[0] > 5 || (version[0] === 5 && version[1] >= 2))) {
    return { kind: 'glm-effort', options: GLM_EFFORT_OPTIONS, canDisable: true };
  }
  return null;
}

// ── Grok 渠道 ────────────────────────────────────────────────────────────

export function resolveGrokChannel(input: ReasoningChannelInput): DeepSeekReasoningControl | null {
  const model = gate(input, 'grok');
  if (!model) return null;
  if (model.includes('grok-4.20') && model.includes('multi-agent')) {
    return { kind: 'grok-effort', options: OPENAI_CODEX_EFFORT_OPTIONS, canDisable: false };
  }
  const version = extractModelVersion(model);
  if (version) {
    const [major, minor] = version;
    if (major > 4 || (major === 4 && minor >= 5)) {
      // 2026-10 官方文档：4.5/4.6/4.7 思考不可关闭；xhigh 仅 4.6+（4.5 静默按 high）。
      return {
        kind: 'grok-effort',
        options:
          major > 4 || minor >= 6
            ? [...LOW_MEDIUM_HIGH_EFFORT_OPTIONS, { value: 'xhigh', labelKey: 'settings:api.modal.reasoning.effort.xhigh', defaultLabel: 'Extra High' }]
            : LOW_MEDIUM_HIGH_EFFORT_OPTIONS,
        canDisable: false,
        defaultValue: 'high',
      };
    }
    if (major === 4 && minor >= 3) {
      return { kind: 'grok-effort', options: LOW_MEDIUM_HIGH_EFFORT_OPTIONS, canDisable: true };
    }
  }
  return null;
}

// ── Moonshot Kimi 渠道 ───────────────────────────────────────────────────

export function resolveMoonshotChannel(input: ReasoningChannelInput): DeepSeekReasoningControl | null {
  const model = gate(input, 'moonshot');
  if (!model) return null;
  if (isKimiK3OrLaterModelId(model)) {
    // 2026-10 官方文档：K3 始终思考，effort 可选 low/high/max（默认 max）。
    return {
      kind: 'moonshot-effort',
      options: [
        { value: 'low', labelKey: 'settings:api.modal.reasoning.effort.low', defaultLabel: 'Low' },
        { value: 'high', labelKey: 'settings:api.modal.reasoning.effort.high', defaultLabel: 'High' },
        { value: 'max', labelKey: 'settings:api.modal.deepseek.depth.max', defaultLabel: 'Max' },
      ],
      canDisable: false,
      defaultValue: 'max',
    };
  }
  if (isLegacyKimiForcedThinkingModelId(model) || (model.includes('kimi-k2.7') && model.includes('code'))) {
    return { kind: 'toggle-only', options: [], canDisable: false };
  }
  return null;
}

// ── Mistral / ERNIE 渠道 ─────────────────────────────────────────────────

export function resolveMistralChannel(input: ReasoningChannelInput): DeepSeekReasoningControl | null {
  const model = gate(input, 'mistral');
  if (!model || !isMistralEffortModelId(model)) return null;
  return { kind: 'mistral-effort', options: LOW_MEDIUM_HIGH_EFFORT_OPTIONS, canDisable: true };
}

export function resolveErnieChannel(input: ReasoningChannelInput): DeepSeekReasoningControl | null {
  const model = gate(input, 'ernie');
  if (!model || !(model.includes('ernie-5') || model.includes('ernie-x1'))) return null;
  return { kind: 'ernie-effort', options: ERNIE_EFFORT_OPTIONS, canDisable: true };
}

// ── SiliconFlow 宿主渠道（generic 适配器 + SiliconFlow 宿主的非 DeepSeek/Qwen 家族）──

export function resolveSiliconFlowChannel(input: ReasoningChannelInput): DeepSeekReasoningControl | null {
  if (!isSiliconFlowHost(input)) return null;
  const model = normalize(input.model) || normalize(input.modelId);
  // SiliconFlow 宿主方言：enable_thinking + thinking_budget（官方范围 128–32768），
  // 档位尺度为本宿主自有（2048/8192/16384/32768），不借用 DeepSeek V3.2 语义。
  if (isForcedThinkingModelId(model)) {
    return { kind: 'toggle-only', options: [], canDisable: false };
  }
  return { kind: 'v32-budget-effort', options: V32_EFFORT_OPTIONS, canDisable: true };
}

// ── Generic / OpenAI 兼容渠道（兜底成员）────────────────────────────────

/**
 * Generic 渠道：默认只有思考开关。
 *
 * 用户在设置页打开"思考强度"开关（supportsReasoning）后，提供
 * low/medium/high/xhigh 四档自定义档位（顶层 reasoning_effort，
 * 与 GPT-5.2+ 的采样参数互斥规则由后端 generic 适配器处理）。
 */
export function resolveGenericChannel(input: ReasoningChannelInput): DeepSeekReasoningControl {
  const model = normalize(input.model) || normalize(input.modelId);
  if (input.supportsReasoning === true) {
    return { kind: 'openai-effort', options: OPENAI_CODEX_EFFORT_OPTIONS, canDisable: true };
  }
  return {
    kind: 'toggle-only',
    options: [],
    canDisable: !isForcedThinkingModelId(model),
  };
}

// ── 注册表 ───────────────────────────────────────────────────────────────

/**
 * 渠道注册表：键为 get_adapter 命中的适配器 id（含注册表别名，统一在
 * normalizeAdapterId 收敛到主 id）。渠道解析返回 null 表示该渠道对当前
 * 模型没有思考强度语义，由调用方回退（家族渠道→仅开关，宿主渠道→generic）。
 */
export type ReasoningChannel = (input: ReasoningChannelInput) => DeepSeekReasoningControl | null;

export const REASONING_CHANNELS: Record<string, ReasoningChannel> = {
  qwen: resolveQwenChannel,
  deepseek: resolveDeepSeekChannel,
  openai: resolveOpenAiChannel,
  general: (input) => {
    // generic 适配器同时服务 OpenAI 兼容宿主与 SiliconFlow 宿主：
    // SiliconFlow 宿主优先走宿主方言，其余按 OpenAI 兼容模型家族识别。
    return resolveSiliconFlowChannel(input) ?? resolveOpenAiChannel(input);
  },
  siliconflow: (input) => resolveQwenChannel(input) ?? resolveSiliconFlowChannel(input),
  nvidia: resolveOpenAiChannel,
  google: resolveGeminiChannel,
  gemini: resolveGeminiChannel,
  anthropic: resolveClaudeChannel,
  claude: resolveClaudeChannel,
  zhipu: resolveZhipuChannel,
  grok: resolveGrokChannel,
  xai: resolveGrokChannel,
  moonshot: resolveMoonshotChannel,
  kimi: resolveMoonshotChannel,
  mistral: resolveMistralChannel,
  ernie: resolveErnieChannel,
  baidu: resolveErnieChannel,
};

export function normalizeAdapterId(adapterId: string | undefined | null): string | undefined {
  const id = normalize(adapterId);
  return id || undefined;
}
