// 渠道注册表（2026-10-03，方案 F）。
//
// ## 解析路径（单一、无跨渠道兜底）
// 1. adapterId 命中已注册渠道 → 该渠道自决。
// 2. 渠道返回 null（该渠道对该模型无思考语义）→ 中性兜底
//    （支持思考的模型给统一五档，否则仅开关）。
// 3. adapterId 缺失（存量数据）→ 按模型名做家族识别，命中家族渠道则用之，
//    否则中性兜底。
//
// ## 与旧实现的区别（交叉判定链已删除）
// 旧版有两条跨渠道链：
//   - 宿主渠道 `hostResolve ?? sweepFamilies ?? resolveGenericChannel`
//   - 家族清扫 `FAMILY_SWEEP_ORDER` 按 10 个家族依次尝试
// 二者会让"OpenAI 宿主上的 Gemini 模型"由 Gemini 渠道映射、而"Gemini 宿主上的
// OpenAI 模型"由 OpenAI 渠道映射，档位语义随编排顺序漂移——历史上
// gpt-6 被折叠、Gemini low 被改写均与此有关。
//
// 现规则：**渠道只按自身身份判定**。adapterId 缺失时用模型名确定唯一家族，
// 不再"依次尝试直到某个命中"。因为所有渠道返回的档位集合已统一，
// 编排层的存在意义也随之消失。

import {
  REASONING_CHANNELS,
  channelModelId,
  normalizeAdapterId,
  resolveGenericChannel,
  toggleOnlyControl,
  unifiedControl,
  type ReasoningChannelInput,
  type ReasoningControl,
  type ReasoningLevel,
} from './channels';
import { matchModelFamily, type ModelFamily } from './modelFamily';

/** 家族 → 渠道 id（用于 adapterId 缺失时按模型名定位唯一渠道）。 */
const FAMILY_CHANNEL_ID: Record<ModelFamily, string | undefined> = {
  qwen: 'qwen',
  deepseek: 'deepseek',
  zhipu: 'zhipu',
  moonshot: 'moonshot',
  grok: 'grok',
  gemini: 'gemini',
  claude: 'claude',
  openai: 'openai',
  doubao: 'doubao',
  minimax: 'minimax',
  ernie: 'ernie',
  mimo: undefined,
  mistral: 'mistral',
};

/** 默认档为渠道最高档（options 末位）。 */
function withHighestDefault(control: ReasoningControl): ReasoningControl {
  if (control.options.length === 0) return control;
  const highest = control.options[control.options.length - 1].value as ReasoningLevel;
  if (control.defaultValue === highest) return control;
  return { ...control, defaultValue: highest };
}

/**
 * 解析思考强度控制对象（唯一公共入口）。
 *
 * 所有渠道返回的 options 都是统一五档；差异只体现在 `canDisable`
 * 与 `kind`。哪一档对该模型真正可用由后端能力表在请求前映射。
 */
export function resolveReasoningControl(input: ReasoningChannelInput): ReasoningControl {
  const channelId = normalizeAdapterId(
    typeof input.adapterId === 'string' ? input.adapterId : undefined
  );

  // 1. 渠道身份已知：该渠道自决（渠道间零引用）。
  if (channelId) {
    const channel = REASONING_CHANNELS[channelId];
    if (channel) {
      const control = channel(input);
      if (control) return control;
      // 渠道明确表示"对该模型无思考语义"→ 中性兜底，不转交其他家族。
      return withHighestDefault(resolveGenericChannel(input));
    }
    // 未注册的 adapterId：同样走中性兜底。
    return withHighestDefault(resolveGenericChannel(input));
  }

  // 2. adapterId 缺失：按模型名定位唯一家族渠道（不再依次清扫）。
  const family = matchModelFamily(channelModelId(input));
  const familyChannelId = family ? FAMILY_CHANNEL_ID[family] : undefined;
  if (familyChannelId) {
    const control = REASONING_CHANNELS[familyChannelId]?.(input);
    if (control) return control;
  }

  // 3. 家族未识别 → 中性兜底。
  return withHighestDefault(resolveGenericChannel(input));
}

export { matchModelFamily };
export { toggleOnlyControl, unifiedControl };
export type { ReasoningControl, ReasoningChannelInput, ReasoningLevel };
