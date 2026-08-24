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
export { buildGenerativeUISystemPrompt, LEARNING_DASHBOARD_EXAMPLE } from './prompts';

// 注册内置块
import './blocks';
