// 渠道注册表：把 resolvedAdapterId 映射到渠道 resolve 函数。
//
// 两条路径：
// 1. 身份路径（主路径）：adapterId 命中渠道 → 渠道内自行解析。渠道对陌生模型
//    返回 null 时回退"仅开关"（家族渠道）或 generic（宿主渠道），不再被其他
//    家族的判定分支"截胡"。
// 2. 兜底路径：adapterId 缺失（旧存量数据、字段未下发）→ 走
//    deepseekReasoningControls 的原判定链，行为与重构前一致。
//
// 方案 E：匹配后的默认档统一取**渠道最高档**（options 末位）——用户未显式
// 选择时按最高档发送；canDisable=false 的强制渠道同样适用。
//
// 宿主渠道（general/openai/siliconflow/nvidia）：适配器只认"宿主"，模型家族
// 可能是外部家族（如在 generic 上托管 gemini-3）。这类渠道按
// 宿主方言 → 家族清扫 → generic 的顺序解析；家族清扫按固定文档化顺序调用
// 各家族渠道模块（每个家族的判定逻辑仍归各自渠道所有，此处只是编排）。

import {
  resolveDeepSeekRuntimeReasoningControl as legacyResolveControl,
  isForcedThinkingModelId,
  type DeepSeekReasoningControl,
  type DeepSeekReasoningOptionValue,
} from '../deepseekReasoningControls';
import {
  REASONING_CHANNELS,
  normalizeAdapterId,
  resolveGenericChannel,
  type ReasoningChannelInput,
} from './channels';
import { matchModelFamily } from './modelFamily';

const FAMILY_CHANNEL_IDS = new Set([
  'qwen',
  'deepseek',
  'google',
  'gemini',
  'anthropic',
  'claude',
  'zhipu',
  'grok',
  'xai',
  'moonshot',
  'kimi',
  'mistral',
  'ernie',
  'baidu',
]);

const HOST_CHANNEL_IDS = new Set(['general', 'openai', 'siliconflow', 'nvidia']);

// 家族清扫顺序：与旧判定链的家族分支顺序一致（openai 优先于 qwen，
// qwen 优先于 deepseek 的既有次序在此保持，仅作存量行为兼容）。
const FAMILY_SWEEP_ORDER = [
  'openai',
  'qwen',
  'deepseek',
  'gemini',
  'claude',
  'zhipu',
  'grok',
  'moonshot',
  'mistral',
  'ernie',
] as const;

function sweepFamilies(input: ReasoningChannelInput): DeepSeekReasoningControl | null {
  for (const family of FAMILY_SWEEP_ORDER) {
    const resolve = REASONING_CHANNELS[family];
    const control = resolve?.(input);
    if (control) return control;
  }
  return null;
}

/** 家族渠道对陌生模型的兜底：仅思考开关（不给 effort 档位——该家族未声明支持）。 */
function fallbackToggleOnly(input: ReasoningChannelInput): DeepSeekReasoningControl {
  const model =
    typeof input.model === 'string'
      ? input.model
      : typeof input.modelId === 'string'
        ? input.modelId
        : '';
  return {
    kind: 'toggle-only',
    options: [],
    canDisable: !isForcedThinkingModelId(model.trim().toLowerCase()),
  };
}

/** 方案 E：默认档统一取渠道最高档（options 末位）。 */
function withHighestDefault(control: DeepSeekReasoningControl): DeepSeekReasoningControl {
  if (control.options.length === 0) return control;
  const highest = control.options[control.options.length - 1].value as DeepSeekReasoningOptionValue;
  if (control.defaultValue === highest) return control;
  return { ...control, defaultValue: highest };
}

/**
 * 解析思考强度控制对象（渠道并行主入口）。
 *
 * @param input 模型身份与渠道信息；adapterId 推荐传后端下发的 resolvedAdapterId
 *              （或设置页表单里用户显式选择的 modelAdapter）。
 */
export function resolveReasoningControl(input: ReasoningChannelInput): DeepSeekReasoningControl {
  const channelId = normalizeAdapterId(
    typeof input.adapterId === 'string' ? input.adapterId : undefined
  );

  if (channelId && HOST_CHANNEL_IDS.has(channelId)) {
    const hostResolve = REASONING_CHANNELS[channelId];
    const control = hostResolve?.(input) ?? sweepFamilies(input) ?? resolveGenericChannel(input);
    return withHighestDefault(control);
  }

  if (channelId && FAMILY_CHANNEL_IDS.has(channelId)) {
    const control = REASONING_CHANNELS[channelId]?.(input) ?? fallbackToggleOnly(input);
    return withHighestDefault(control);
  }

  // resolvedAdapterId 缺失：退回原判定链（行为与重构前完全一致）。
  // 命中的控制对象同样应用最高档默认（方案 E）。
  return withHighestDefault(legacyResolveControl(input));
}

/** 便捷判定：模型 ID 属于哪个家族（包含匹配）。 */
export { matchModelFamily };
