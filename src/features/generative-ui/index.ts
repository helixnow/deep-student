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
  GenerativeActionUndoFn,
  GenerativeActionHandlerResult,
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
export { resolveEffectiveRiskLevel, withGenerativeActionInstrumentation } from './actions';
export type { GenerativeActionInstrumentationOptions } from './actions';
export {
  wrapActionWithTelemetry,
  emitGenerativeActionTelemetry,
  defaultGenerativeActionTelemetrySink,
  GenerativeActionUndoStack,
  wrapReversibleAction,
  resolveGenerativeActionUndo,
  getDefaultGenerativeActionUndoStack,
  resetDefaultGenerativeActionUndoStack,
  GENERATIVE_ACTION_UNDO_STACK_LIMIT,
} from './handlers';
export type {
  GenerativeActionTelemetryEvent,
  GenerativeActionTelemetrySink,
  GenerativeActionTelemetryPhase,
  GenerativeActionUndoEntry,
  GenerativeActionUndoStackOptions,
  ReversibleGenerativeActionDefinition,
} from './handlers';
export { buildGenerativeUISystemPrompt, LEARNING_DASHBOARD_EXAMPLE } from './prompts';
export { buildNoteSummaryIntent } from './utils/buildNoteSummaryIntent';
export { buildLearningBriefingIntent } from './utils/buildLearningBriefingIntent';
export { buildAiDashboardIntent } from './utils/buildAiDashboardIntent';
export { buildAIDiffSummaryIntent } from './utils/buildAIDiffSummaryIntent';
export { buildLearningHubBriefingIntent } from './utils/buildLearningHubBriefingIntent';
export { buildExamBriefingIntent } from './utils/buildExamBriefingIntent';
export { buildTranslationBriefingIntent } from './utils/buildTranslationBriefingIntent';
export { mergeTranslationBriefingMetrics } from './utils/mergeTranslationBriefingMetrics';
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
export { createTranslationBriefingActionHandlers } from './handlers/translationBriefingActionHandlers';
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
export {
  HPIAS_EVENT_CHANNEL,
  createHpiasEventBridgeHandler,
  intentHasResearchBlocks,
  normalizeHpiasEventPayload,
  omitResearchBlocksFromIntent,
  startHpiasEventBridge,
} from './bridge/hpiasEventBridge';
export { useHpiasEventBridge } from './hooks/useHpiasEventBridge';
export {
  HPIAS_PIPELINE_LIFECYCLE,
  HPIAS_REQUIRED_LIFECYCLE_TYPES,
  assertHpiasLifecycleCoverage,
  extractHpiasEventTypes,
} from './contracts/hpiasLifecycleContract';
export type { HpiasPipelineLifecycleType } from './contracts/hpiasLifecycleContract';
export { extractResearchSessionId } from './utils/extractResearchSessionId';
export { buildFlashcardPreviewIntent } from './utils/buildFlashcardPreviewIntent';
export { buildPaperDigestIntent } from './utils/buildPaperDigestIntent';
export { buildResearchPlanIntent } from './utils/buildResearchPlanIntent';
export { buildResearchReportIntent } from './utils/buildResearchReportIntent';
export {
  mapHpiasStoreToResearchPlanSteps,
  pickHpiasResearchSnapshot,
} from './utils/mapHpiasStoreToResearchPlan';
export type {
  HpiasResearchSnapshot,
  HpiasResearchPlanLabels,
} from './utils/mapHpiasStoreToResearchPlan';
export { buildHpiasResearchDashboardIntent } from './utils/buildHpiasResearchDashboardIntent';
export type { HpiasResearchDashboardLabels } from './utils/buildHpiasResearchDashboardIntent';
export { HpiasGenerativeResearchPanel } from './components/HpiasGenerativeResearchPanel';
export {
  parseResearchReportCitations,
  countResearchReportCitations,
  RESEARCH_REPORT_CITATION_PATTERN,
} from './utils/parseResearchReportCitations';
export {
  extractFlashcardsFromIntent,
  flashcardPreviewToAnkiCards,
} from './utils/extractFlashcardsFromIntent';
export { createFlashcardSaveActionHandlers } from './handlers/flashcardActionHandlers';
export type { FlashcardSaveContext, FlashcardActionLabels } from './handlers/flashcardActionHandlers';
export {
  resolveGenerativeUIChatActionHandlers,
  collectGenerativeUIActionIds,
  NOTE_EDIT_ACTION_IDS,
  FLASHCARD_ACTION_IDS,
  RESEARCH_ACTION_IDS,
} from './bridge/resolveGenerativeUIChatActionHandlers';
export { createResearchBriefingActionHandlers } from './handlers/researchBriefingActionHandlers';
export type {
  ResearchBriefingActionCallbacks,
  ResearchBriefingActionLabels,
} from './handlers/researchBriefingActionHandlers';
export {
  extractResearchReportBody,
  buildResearchExportMarkdownFromIntent,
} from './utils/extractResearchContentFromIntent';
export { buildResearchExportMarkdownFromSnapshot } from './utils/buildResearchExportMarkdown';
export { extractNoteEditPayload, noteEditPayloadSchema } from './utils/extractNoteEditPayload';
export type { NoteEditPayload } from './utils/extractNoteEditPayload';
export { schemaToPromptHint } from './utils/schemaToPromptHint';
export { MarkdownBlock, markdownPropsSchema } from './components/MarkdownBlock';
export { buildMarkdownIntent } from './utils/buildMarkdownIntent';
export { ChartBlock, chartBlockPropsSchema, CHART_BLOCK_TYPE, registerChartBlock } from './components/ChartBlock';
export { buildChartIntent } from './utils/buildChartIntent';
export { StepsBlock, stepsBlockPropsSchema, STEPS_BLOCK_TYPE, registerStepsBlock } from './components/StepsBlock';
export { buildStepsIntent } from './utils/buildStepsIntent';
export { buildLearningPlanStepsIntent } from './utils/buildLearningPlanStepsIntent';
export {
  TableBlock,
  tableBlockPropsSchema,
  tableColumnSchema,
  TABLE_BLOCK_TYPE,
  registerTableBlock,
} from './components/TableBlock';
export type { TableBlockProps, TableColumn } from './components/TableBlock';
export { buildTableIntent } from './utils/buildTableIntent';
export type { TableIntentInput, TableIntentLabels } from './utils/buildTableIntent';
export { coercePartialIntent } from './utils/coercePartialIntent';
export type { CoercePartialIntentResult } from './utils/coercePartialIntent';

// 注册内置块
import './blocks';
