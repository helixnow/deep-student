/**
 * `QBankExecutor` — Rust `src-tauri/src/chat_v2/tools/qbank_executor.rs` (`impl ToolExecutor`,
 * lines 5404-5635). Tool schemas reach the model from the shared frontend skill
 * (`src/features/chat/skills/builtin-tools/qbank-tools.ts`); this executor owns routing,
 * risk classification and execution.
 */
import type {
  ExecutionContext, ToolCall, ToolConcurrency, ToolExecutor, ToolResultInfo, ToolSensitivity,
} from '../../../chat/api.ts';
import { strip_tool_namespace } from '../../../../platform/errors/api.ts';
import { argsObject, localizedQbankFailure } from './qbank-tool-args.ts';
import { QbankToolEnv, type QbankToolDeps } from './qbank-tool-env.ts';
import * as authoringTools from './qbank-tools-authoring.ts';
import * as exportTools from './qbank-tools-export.ts';
import * as importTools from './qbank-tools-import.ts';
import * as practiceTools from './qbank-tools-practice.ts';
import * as progressTools from './qbank-tools-progress.ts';
import * as questionTools from './qbank-tools-questions.ts';
import * as structureTools from './qbank-tools-structure.ts';
import { runToolWithEvents, WriteLock } from './tool-execution.ts';

export type { QbankToolDeps } from './qbank-tool-env.ts';
export { QBANK_CHANGED_EVENT } from './qbank-tool-env.ts';

/** qbank_executor.rs:5405 `can_handle`, in Rust order. */
export const QBANK_RUST_TOOL_NAMES = [
  'qbank_list', 'qbank_list_questions', 'qbank_get_question', 'qbank_create_question', 'qbank_delete_questions',
  'qbank_toggle_favorite', 'qbank_toggle_bookmark', 'qbank_get_submissions', 'qbank_get_question_history',
  'qbank_batch_update_questions', 'qbank_list_source_images', 'qbank_search_questions', 'qbank_submit_answer',
  'qbank_update_question', 'qbank_get_stats', 'qbank_get_next_question', 'qbank_start_timed_practice',
  'qbank_generate_mock_exam', 'qbank_submit_mock_exam', 'qbank_get_daily_practice', 'qbank_get_check_in_calendar', // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
  'qbank_generate_paper', 'qbank_list_papers', 'qbank_get_paper', 'qbank_list_practices', 'qbank_get_learning_trend',
  'qbank_get_activity_heatmap', 'qbank_get_knowledge_stats', 'qbank_generate_variant', 'qbank_batch_import',
  'qbank_list_authoring_drafts', 'qbank_get_authoring_draft', 'qbank_review_authoring_draft',
  'qbank_commit_authoring_draft', 'qbank_list_structure', 'qbank_update_group', 'qbank_delete_group',
  'qbank_update_material', 'qbank_delete_material', 'qbank_import_document', 'qbank_reset_progress', 'qbank_export',
  'qbank_ai_grade', 'qbank_generate_questions', 'qbank_get_generation_task',
] as const;

type QbankToolName = typeof QBANK_RUST_TOOL_NAMES[number];

/**
 * BG-4 user-data-management extensions: mistake-book listing and paper/practice
 * maintenance. They have no Rust `qbank_executor.rs` counterpart, so they are
 * tracked separately from {@link QBANK_RUST_TOOL_NAMES}.
 */
export const QBANK_EXTENSION_TOOL_NAMES = [
  'qbank_list_mistakes', 'qbank_update_paper', 'qbank_delete_practice',
] as const;

type QbankExtensionToolName = typeof QBANK_EXTENSION_TOOL_NAMES[number];
type AnyQbankToolName = QbankToolName | QbankExtensionToolName;
type ToolBody = (env: QbankToolEnv) => unknown | Promise<unknown>;

/** Executable bodies; Rust tools absent here are not claimed, so their schemas are not routed to this executor. */
const BODIES: Partial<Record<AnyQbankToolName, ToolBody>> = {
  qbank_list: questionTools.executeList,
  qbank_list_questions: questionTools.executeListQuestions,
  qbank_get_question: questionTools.executeGetQuestion,
  qbank_create_question: questionTools.executeCreateQuestion,
  qbank_delete_questions: questionTools.executeDeleteQuestions,
  qbank_toggle_favorite: questionTools.executeToggleFavorite,
  qbank_toggle_bookmark: questionTools.executeToggleBookmark,
  qbank_get_submissions: questionTools.executeGetSubmissions,
  qbank_get_question_history: questionTools.executeGetQuestionHistory,
  qbank_batch_update_questions: questionTools.executeBatchUpdateQuestions,
  qbank_list_source_images: questionTools.executeListSourceImages,
  qbank_search_questions: questionTools.executeSearchQuestions,
  qbank_submit_answer: progressTools.executeSubmitAnswer,
  qbank_update_question: questionTools.executeUpdateQuestion,
  qbank_get_stats: questionTools.executeGetStats,
  qbank_get_next_question: progressTools.executeGetNextQuestion,
  qbank_reset_progress: progressTools.executeResetProgress,
  qbank_start_timed_practice: practiceTools.executeStartTimedPractice,
  qbank_generate_mock_exam: practiceTools.executeGenerateMockExam, // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
  qbank_submit_mock_exam: practiceTools.executeSubmitMockExam, // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
  qbank_get_daily_practice: practiceTools.executeGetDailyPractice,
  qbank_get_check_in_calendar: practiceTools.executeGetCheckInCalendar,
  qbank_get_learning_trend: practiceTools.executeGetLearningTrend,
  qbank_get_activity_heatmap: practiceTools.executeGetActivityHeatmap,
  qbank_get_knowledge_stats: practiceTools.executeGetKnowledgeStats,
  qbank_list_papers: practiceTools.executePracticeRecords,
  qbank_get_paper: practiceTools.executePracticeRecords,
  qbank_list_practices: practiceTools.executePracticeRecords,
  qbank_list_structure: structureTools.executeStructure,
  qbank_update_group: structureTools.executeStructure,
  qbank_delete_group: structureTools.executeStructure,
  qbank_update_material: structureTools.executeStructure,
  qbank_delete_material: structureTools.executeStructure,
  qbank_list_authoring_drafts: structureTools.executeAuthoringDraft,
  qbank_get_authoring_draft: structureTools.executeAuthoringDraft,
  qbank_review_authoring_draft: structureTools.executeAuthoringDraft,
  qbank_commit_authoring_draft: structureTools.executeAuthoringDraft,
  qbank_get_generation_task: structureTools.executeGetGenerationTask,
  qbank_ai_grade: structureTools.executeAiGrade,
  qbank_generate_variant: authoringTools.executeGenerateVariant,
  qbank_generate_questions: authoringTools.executeGenerateQuestions,
  qbank_batch_import: authoringTools.executeBatchImport,
  qbank_generate_paper: exportTools.executeGeneratePaper,
  qbank_export: exportTools.executeExport,
  qbank_import_document: importTools.executeImportDocument,
  qbank_list_mistakes: questionTools.executeListMistakes,
  qbank_update_paper: practiceTools.executeUpdatePaper,
  qbank_delete_practice: practiceTools.executeDeletePractice,
};

export const QBANK_TOOL_NAMES: readonly AnyQbankToolName[] = [
  ...QBANK_RUST_TOOL_NAMES.filter(name => BODIES[name] !== undefined),
  ...QBANK_EXTENSION_TOOL_NAMES,
];
/** Rust tools whose host bodies (LLM generation, document import, paper/export rendering) are still pending. */
export const QBANK_PENDING_TOOL_NAMES: readonly QbankToolName[] = QBANK_RUST_TOOL_NAMES.filter(name => BODIES[name] === undefined);

/** qbank_executor.rs:5574 `sensitivity_level`. */
export function qbankSensitivity(toolName: string): ToolSensitivity {
  switch (strip_tool_namespace(toolName)) {
    case 'qbank_delete_questions': case 'qbank_delete_group': case 'qbank_delete_material':
    case 'qbank_delete_practice':
      return 'high';
    case 'qbank_create_question': case 'qbank_toggle_favorite': case 'qbank_toggle_bookmark':
    case 'qbank_submit_answer': case 'qbank_update_question': case 'qbank_batch_update_questions':
    case 'qbank_generate_paper': case 'qbank_batch_import': case 'qbank_review_authoring_draft':
    case 'qbank_commit_authoring_draft': case 'qbank_update_group': case 'qbank_update_material':
    case 'qbank_import_document': case 'qbank_reset_progress': case 'qbank_export': case 'qbank_ai_grade':
    case 'qbank_generate_questions': case 'qbank_update_paper':
      return 'medium';
    default:
      return 'low';
  }
}

/** qbank_executor.rs:5607 `concurrency_class`. */
export function qbankConcurrency(toolName: string): ToolConcurrency {
  switch (strip_tool_namespace(toolName)) {
    case 'qbank_list': case 'qbank_list_questions': case 'qbank_get_question': case 'qbank_get_submissions':
    case 'qbank_get_question_history': case 'qbank_list_source_images': case 'qbank_search_questions':
    case 'qbank_list_papers': case 'qbank_get_paper': case 'qbank_list_practices': case 'qbank_get_stats':
    case 'qbank_get_learning_trend': case 'qbank_get_activity_heatmap': case 'qbank_get_knowledge_stats':
    case 'qbank_get_check_in_calendar': case 'qbank_list_mistakes':
      return 'read_only';
    default:
      return 'serial';
  }
}

export class QBankExecutor implements ToolExecutor {
  private readonly deps: QbankToolDeps;
  private readonly lock = new WriteLock();

  constructor(deps: QbankToolDeps) { this.deps = deps; }

  name(): string { return 'QBankExecutor'; }

  canHandle(toolName: string): boolean {
    return BODIES[strip_tool_namespace(toolName) as AnyQbankToolName] !== undefined;
  }

  sensitivityLevel(toolName: string): ToolSensitivity { return qbankSensitivity(toolName); }

  concurrencyClass(toolName: string): ToolConcurrency { return qbankConcurrency(toolName); }

  execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const toolName = strip_tool_namespace(call.name);
    return runToolWithEvents(this.name(), toolName, call, ctx, this.deps.log, async () => {
      const body = BODIES[toolName as AnyQbankToolName];
      if (body === undefined) throw new Error(`Unknown qbank tool: ${toolName}`);
      return await body(new QbankToolEnv(this.deps, ctx, call, argsObject(call.arguments), toolName, this.lock));
    }, localizedQbankFailure);
  }
}
