// 渠道并行思考强度（方案 D）公共入口。
//
// 消费者应使用 resolveReasoningControl（渠道身份主路径）而不是直接调用
// deepseekReasoningControls 的旧判定链；共享的档位表/换算函数/选择解释器
// 仍从 deepseekReasoningControls 导入。

export { resolveReasoningControl } from './registry';
export {
  REASONING_CHANNELS,
  normalizeAdapterId,
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
  resolveSiliconFlowChannel,
  type ReasoningChannelInput,
} from './channels';
