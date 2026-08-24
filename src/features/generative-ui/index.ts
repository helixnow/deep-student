/**
 * Generative UI — 结构化意图 + 组件注册表
 *
 * @see docs/generative-ui/ARCHITECTURE.md
 */

export type {
  GenerativeBlockProps,
  GenerativeComponentConfig,
  GenerativeBlockIntent,
  GenerativeUIIntent,
  ParseResult,
  GenerativeUIAction,
  RiskLevel,
  GenerativeActionDefinition,
  GenerativeUIRendererProps,
} from './types';

export { generativeUIRegistry } from './registry';
export {
  generativeUIIntentSchema,
  generativeBlockIntentSchema,
  parseGenerativeUIIntent,
  validateBlockProps,
} from './schema';
export { GenerativeUIStreamParser, tryParsePartialIntent } from './parser';
export { GenerativeUIRenderer } from './GenerativeUIRenderer';
export { GenerativeUIChrome } from './GenerativeUIChrome';
export { GenerativeUIPanel } from './components/GenerativeUIPanel';
export { useGenerativeUIStream } from './hooks/useGenerativeUIStream';
export { resolveEffectiveRiskLevel } from './actions';
export { buildGenerativeUISystemPrompt, LEARNING_DASHBOARD_EXAMPLE } from './prompts';
export { buildNoteSummaryIntent } from './utils/buildNoteSummaryIntent';
export { learningActionHandlers } from './handlers/learningActionHandlers';
export { extractGenerativeUIIntent, GENERATIVE_UI_BLOCK_TYPE } from './bridge/chatBlockBridge';

// 注册内置块
import './blocks';
