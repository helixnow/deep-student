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
export type { GenerativeUIStreamPhase, GenerativeUIStreamSnapshot } from './parser';
export {
  appendGenerativeUIStreamContent,
  finalizeGenerativeUIStream,
  resetGenerativeUIStream,
  clearGenerativeUIStreamRegistry,
} from './bridge/generativeUIStreamRegistry';
export { GenerativeUIRenderer } from './GenerativeUIRenderer';
export { GenerativeUIChrome } from './GenerativeUIChrome';
export { GenerativeUIPanel } from './components/GenerativeUIPanel';
export { useGenerativeUIStream } from './hooks/useGenerativeUIStream';
export { resolveEffectiveRiskLevel } from './actions';
export { buildGenerativeUISystemPrompt, LEARNING_DASHBOARD_EXAMPLE } from './prompts';
export { buildNoteSummaryIntent } from './utils/buildNoteSummaryIntent';
export { buildLearningBriefingIntent } from './utils/buildLearningBriefingIntent';
export { buildAIDiffSummaryIntent } from './utils/buildAIDiffSummaryIntent';
export { buildLearningHubBriefingIntent } from './utils/buildLearningHubBriefingIntent';
export { buildExamBriefingIntent } from './utils/buildExamBriefingIntent';
export { buildIndexStatusBriefingIntent } from './utils/buildIndexStatusBriefingIntent';
export { buildMemoryBriefingIntent } from './utils/buildMemoryBriefingIntent';
export { buildNoteEditSuggestionIntent } from './utils/buildNoteEditSuggestionIntent';
export {
  dispatchCanvasAIEditRequest,
  createCanvasEditRequestId,
} from './utils/dispatchCanvasAIEditRequest';
export type {
  CanvasAIEditDispatchPayload,
  CanvasAIEditDispatchResult,
} from './utils/dispatchCanvasAIEditRequest';
export { createExamBriefingActionHandlers } from './handlers/examBriefingActionHandlers';
export { createIndexStatusBriefingActionHandlers } from './handlers/indexStatusBriefingActionHandlers';
export { createMemoryBriefingActionHandlers } from './handlers/memoryBriefingActionHandlers';
export { createNotesEditActionHandlers } from './handlers/notesEditActionHandlers';
export type {
  NoteEditSuggestionPayload,
  NotesEditActionLabels,
  NotesEditActionCallbacks,
} from './handlers/notesEditActionHandlers';
export { learningActionHandlers } from './handlers/learningActionHandlers';
export { workbenchLearningHandlers } from './handlers/workbenchLearningHandlers';
export { learningHubActionHandlers } from './handlers/learningHubActionHandlers';
export { extractGenerativeUIIntent, GENERATIVE_UI_BLOCK_TYPE } from './bridge/chatBlockBridge';

// 注册内置块
import './blocks';
