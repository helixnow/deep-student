// 思考强度（2026-10-03，方案 F）——**前端唯一公共出口**。
//
// ## 模块结构
// - `levels.ts`      统一五档表 + 控制对象构造（数据）
// - `modelFamily.ts` 模型家族识别与全部子型号判定（判定单一来源）
// - `channels.ts`    各渠道 resolve（只按自身身份判定，零交叉引用）
// - `registry.ts`    渠道查找与中性兜底（唯一入口 resolveReasoningControl）
// - `conversions.ts` 档位↔thinking_budget 数值换算（历史方言兼容）
//
// ## 已删除
// 旧文件 `src/utils/deepseekReasoningControls.ts` 及其别名
// `src/features/settings/components/deepseekReasoningControls.ts` 已删除：
// 它们同时持有档位表与家族判定，与 reasoning/ 目录构成双份判定链。

export {
  UNIFIED_REASONING_LEVELS,
  REASONING_LEVEL_RANK,
  coerceReasoningLevel,
  unifiedControl,
  toggleOnlyControl,
  type ReasoningLevel,
  type ReasoningLevelOption,
  type ReasoningControl,
  type ReasoningControlKind,
} from './levels';

export {
  matchModelFamily,
  extractModelVersion,
  matchesOpenAiOSeries,
  matchesOpenAiGptFamily,
  isGpt6ModelId,
  isDeepSeekLegacyAliasModelId,
  isDeepSeekV4ModelId,
  isDeepSeekV32ModelId,
  isDeepSeekR1ModelId,
  isQwenForcedThinkingModelId,
  isQwenPureThinkingModelId,
  isKimiK3OrLaterModelId,
  isLegacyKimiForcedThinkingModelId,
  isGlm52OrLaterModelId,
  isGrok43OrLaterModelId,
  isGrokMultiAgentModelId,
  isMistralEffortModelId,
  isClaudeAdaptiveModelId,
  isClaudeAlwaysOnModelId,
  isClaudeOpus55ModelId,
  isForcedThinkingModelId,
  isGemini3ModelId,
  type ModelFamily,
} from './modelFamily';

export {
  REASONING_CHANNELS,
  normalizeAdapterId,
  channelModelId,
  resolveGenericChannel,
  resolveQwenChannel,
  resolveDeepSeekChannel,
  resolveOpenAiChannel,
  resolveGeminiChannel,
  resolveClaudeChannel,
  resolveZhipuChannel,
  resolveGrokChannel,
  resolveMoonshotChannel,
  resolveMistralChannel,
  resolveErnieChannel,
  resolveMinimaxChannel,
  resolveDoubaoChannel,
  type ReasoningChannel,
  type ReasoningChannelInput,
} from './channels';

export { resolveReasoningControl } from './registry';

export {
  DEEPSEEK_V32_EFFORT_BUDGETS,
  QWEN_EFFORT_BUDGETS,
  deepSeekV32EffortToBudget,
  deepSeekV32BudgetToEffort,
  qwenEffortToBudget,
  qwenBudgetToEffort,
} from './conversions';

export { isOfficialDeepSeekEndpoint } from './endpoints';
