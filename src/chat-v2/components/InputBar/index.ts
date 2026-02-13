/**
 * Chat V2 - InputBar 模块导出
 *
 * 包含 @模型解析 和自动完成相关功能
 */

// Hook
export { useModelMentions, type UseModelMentionsOptions, type UseModelMentionsReturn } from './useModelMentions';

// 组件
export { ModelMentionAutoComplete, type ModelMentionAutoCompleteProps } from './ModelMentionAutoComplete';

// 类型从 utils 重导出
export type { ModelInfo, ParsedInput } from '../../utils/parseModelMentions';
