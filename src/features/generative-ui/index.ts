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
export type { UseGenerativeUIStreamResult } from './hooks/useGenerativeUIStream';
export { readPersistedLastGoodFingerprint } from './bridge/generativeUIStreamPersistence';
export {
  useGenerativeUICompact,
  isGenerativeUICompactViewport,
  GENERATIVE_UI_COMPACT_CLASS,
  GENERATIVE_UI_COMPACT_MEDIA_QUERY,
  GENERATIVE_UI_COMPACT_MAX_WIDTH,
} from './hooks/useGenerativeUICompact';
export {
  usePrefersReducedMotion,
  PREFERS_REDUCED_MOTION_QUERY,
} from './hooks/usePrefersReducedMotion';
export {
  usePrefersContrast,
  PREFERS_CONTRAST_QUERY,
} from './hooks/usePrefersContrast';
export {
  lookupGenerativeActionHandler,
  resolveEffectiveRiskLevel,
  withGenerativeActionInstrumentation,
} from './actions';
export type { GenerativeActionInstrumentationOptions } from './actions';
export {
  wrapActionWithTelemetry,
  emitGenerativeActionTelemetry,
  defaultGenerativeActionTelemetrySink,
  wrapActionWithTimeout,
  GENERATIVE_ACTION_TIMEOUT_MS,
  GenerativeActionTimeoutError,
  wrapActionWithRateLimit,
  createActionRateLimiter,
  GENERATIVE_ACTION_COOLDOWN_MS,
  GenerativeActionRateLimitError,
  GenerativeActionTelemetryRing,
  getDefaultGenerativeActionTelemetryRing,
  resetDefaultGenerativeActionTelemetryRing,
  pushDefaultGenerativeActionTelemetry,
  GENERATIVE_ACTION_TELEMETRY_RING_LIMIT,
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
  WrapActionWithTelemetryExtras,
  WrapActionWithTimeoutOptions,
  WrapActionWithRateLimitOptions,
  GenerativeActionUndoEntry,
  GenerativeActionUndoStackOptions,
  ReversibleGenerativeActionDefinition,
} from './handlers';
export { buildGenerativeUISystemPrompt, LEARNING_DASHBOARD_EXAMPLE } from './prompts';
export { buildNoteSummaryIntent } from './utils/buildNoteSummaryIntent';
export { buildLearningBriefingIntent } from './utils/buildLearningBriefingIntent';
export { buildAiDashboardIntent } from './utils/buildAiDashboardIntent';
export { buildAIDiffSummaryIntent } from './utils/buildAIDiffSummaryIntent';
export { buildNoteEditSuggestionIntent } from './utils/buildNoteEditSuggestionIntent';
export {
  dispatchCanvasAIEditRequest,
  createCanvasEditRequestId,
} from './utils/dispatchCanvasAIEditRequest';
export type {
  CanvasAIEditDispatchPayload,
  CanvasAIEditDispatchResult,
} from './utils/dispatchCanvasAIEditRequest';
export { createNotesEditActionHandlers } from './handlers/notesEditActionHandlers';
export type {
  NoteEditSuggestionPayload,
  NotesEditActionLabels,
  NotesEditActionCallbacks,
} from './handlers/notesEditActionHandlers';
export { learningActionHandlers } from './handlers/learningActionHandlers';
export {
  createWorkbenchLearningHandlers,
  workbenchLearningHandlers,
} from './handlers/workbenchLearningHandlers';
export type { WorkbenchLearningHandlerLabels } from './handlers/workbenchLearningHandlers';
export {
  createLearningHubActionHandlers,
  learningHubActionHandlers,
} from './handlers/learningHubActionHandlers';
export {
  createOpenResourceActionHandlers,
  dispatchOpenNoteNavigation,
  dispatchOpenPdfPageNavigation,
  openNoteActionId,
  openPdfPageActionId,
  parseOpenResourceActionId,
  isValidOpenResourceId,
  isValidOpenPdfPageNumber,
  GENERATIVE_UI_OPEN_NOTE_SOURCE,
  OPEN_NOTE_ACTION_PREFIX,
  OPEN_PDF_PAGE_ACTION_PREFIX,
  MAX_OPEN_RESOURCE_ACTION_ID_LENGTH,
  MAX_OPEN_PDF_PAGE_NUMBER,
} from './handlers/openResourceActionHandlers';
export type {
  OpenNoteNavigationTarget,
  OpenPdfPageNavigationTarget,
  OpenResourceActionTarget,
  OpenNoteActionInput,
  OpenPdfPageActionInput,
  OpenResourceActionHandlersInput,
} from './handlers/openResourceActionHandlers';
export { buildOpenResourceEntryBlock } from './utils/buildOpenResourceEntryBlock';
export type { BuildOpenResourceEntryBlockInput } from './utils/buildOpenResourceEntryBlock';
export { extractGenerativeUIIntent, GENERATIVE_UI_BLOCK_TYPE } from './bridge/chatBlockBridge';
export {
  HPIAS_EVENT_CHANNEL,
  createHpiasEventBridgeHandler,
  intentHasResearchBlocks,
  normalizeHpiasEventPayload,
  omitResearchBlocksFromIntent,
  startHpiasEventBridge,
  retainSharedHpiasEventBridge,
  resetSharedHpiasEventBridgeForTests,
} from './bridge/hpiasEventBridge';
export { useHpiasEventBridge } from './hooks/useHpiasEventBridge';
export {
  HPIAS_PIPELINE_LIFECYCLE,
  HPIAS_REQUIRED_LIFECYCLE_TYPES,
  assertHpiasLifecycleCoverage,
  extractHpiasEventTypes,
} from './contracts/hpiasLifecycleContract';
export type { HpiasPipelineLifecycleType } from './contracts/hpiasLifecycleContract';
export {
  extractResearchSessionId,
  MAX_RESEARCH_SESSION_ID_LENGTH,
} from './utils/extractResearchSessionId';
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
  resolveGenerativeUIChatActionHandlers,
  collectGenerativeUIActionIds,
  NOTE_EDIT_ACTION_IDS,
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
export type {
  BuildResearchExportMarkdownFromSnapshotInput,
  ResearchExportMarkdownLabels,
} from './utils/buildResearchExportMarkdown';
export { extractNoteEditPayload, noteEditPayloadSchema } from './utils/extractNoteEditPayload';
export type { NoteEditPayload } from './utils/extractNoteEditPayload';
export { schemaToPromptHint } from './utils/schemaToPromptHint';
export { MarkdownBlock, markdownPropsSchema } from './components/MarkdownBlock';
export { GenerativeUIErrorBoundary } from './components/GenerativeUIErrorBoundary';
export { sanitizeGenerativeMarkdown } from './utils/sanitizeGenerativeMarkdown';
export {
  sanitizeGenerativeText,
  sanitizeGenerativeTextLeaves,
} from './utils/sanitizeGenerativeText';
export { buildMarkdownIntent } from './utils/buildMarkdownIntent';
export { ChartBlock, chartBlockPropsSchema, CHART_BLOCK_TYPE, registerChartBlock, formatChartTooltipValue } from './components/ChartBlock';
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
export { migrateIntentToV11 } from './utils/migrateIntentToV11';
export type {
  MigrateIntentToV11Options,
  MigrateIntentToV11Layout,
} from './utils/migrateIntentToV11';
export { normalizeGenerativeUIIntent } from './utils/normalizeGenerativeUIIntent';
export type {
  NormalizeGenerativeUIIntentOptions,
  NormalizeGenerativeUIIntentResult,
} from './utils/normalizeGenerativeUIIntent';
export {
  fingerprintGenerativeUIIntent,
  stableStringify,
  hashToShortHex,
  FINGERPRINT_HEX_LENGTH,
} from './utils/fingerprintGenerativeUIIntent';
export type { FingerprintGenerativeUIIntentOptions } from './utils/fingerprintGenerativeUIIntent';
export {
  diffGenerativeUIIntent,
  generativeBlockIdentity,
} from './utils/diffGenerativeUIIntent';
export type {
  DiffGenerativeUIIntentResult,
  GenerativeBlockIdentity,
} from './utils/diffGenerativeUIIntent';
export { buildIntentExportMarkdown } from './utils/buildIntentExportMarkdown';
export type { IntentExportMarkdownLabels } from './utils/buildIntentExportMarkdown';
export {
  createCopyIntentActionHandlers,
  COPY_INTENT_ACTION_ID,
} from './handlers/copyIntentActionHandlers';
export {
  createExportIntentActionHandlers,
  EXPORT_INTENT_ACTION_ID,
} from './handlers/exportIntentActionHandlers';
export type { ExportIntentActionLabels } from './handlers/exportIntentActionHandlers';
export {
  createCopyBlockActionHandlers,
  COPY_BLOCK_ACTION_ID,
  serializeGenerativeUIBlock,
} from './handlers/copyBlockActionHandlers';
export type {
  CopyBlockActionLabels,
  CopyBlockActionOptions,
} from './handlers/copyBlockActionHandlers';
export { lintGenerativeUIIntent } from './utils/lintGenerativeUIIntent';
export type {
  GenerativeUILintIssue,
  GenerativeUILintSeverity,
  LintGenerativeUIIntentOptions,
  LintGenerativeUIIntentResult,
} from './utils/lintGenerativeUIIntent';
export {
  assignStableBlockIds,
  makeStableBlockId,
  GENERATED_BLOCK_ID_PREFIX,
} from './utils/assignStableBlockIds';
export type { AssignableBlock } from './utils/assignStableBlockIds';
export {
  formatGenerativeNumber,
  formatGenerativeStatValue,
} from './utils/formatGenerativeNumber';
export { formatGenerativeDate } from './utils/formatGenerativeDate';
export {
  GENERATIVE_URL_SAFE_SCHEMES,
  isDangerousGenerativeUrl,
  isAllowedGenerativeUrl,
  sanitizeGenerativeUrl,
} from './utils/sanitizeGenerativeUrl';
export {
  exportGenerativeUIJsonSchema,
  GENERATIVE_UI_JSON_SCHEMA_ID,
} from './utils/exportGenerativeUIJsonSchema';
export {
  GenerativeUIIntentSnapshotRing,
  getDefaultGenerativeUIIntentSnapshotRing,
  resetDefaultGenerativeUIIntentSnapshotRing,
  pushDefaultGenerativeUIIntentSnapshot,
  GENERATIVE_UI_INTENT_SNAPSHOT_LIMIT,
} from './utils/intentSnapshotRing';
export type { GenerativeUIIntentSnapshot } from './utils/intentSnapshotRing';
export {
  classifyGenerativeUIParseErrors,
} from './utils/classifyGenerativeUIParseErrors';
export type {
  GenerativeUIParseErrorCode,
  ClassifiedGenerativeUIParseError,
} from './utils/classifyGenerativeUIParseErrors';
export {
  collectUnregisteredActionIds,
  firstReachableActionBarIndex,
  intentHasReachableActionBar,
} from './utils/collectUnregisteredActionIds';

// 注册内置块
import './blocks';
