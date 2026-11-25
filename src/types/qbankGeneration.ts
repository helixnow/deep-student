/**
 * 题目集 AI 出题 - 共享类型（2026-09-09 后台任务化）
 *
 * 与 Rust `qbank_generation::types` / `task_repo` 对齐。
 * 单独成文件是为了让 store / hook / 面板都能引用而不产生循环依赖。
 */

import type { QuestionType, Difficulty, QuestionStructuredData, QuestionDocumentV2 } from '@/api/questionBankApi';

export interface GeneratedQuestionOption {
  key: string;
  content: string;
}

export interface GeneratedQuestionDraft {
  local_id?: string;
  group_id?: string | null;
  original_label?: string;
  structured_data?: QuestionStructuredData | null;
  question_type: QuestionType;
  content: string;
  options?: GeneratedQuestionOption[];
  answer?: string;
  explanation?: string;
  difficulty?: Difficulty;
  tags?: string[];
  /** 分子结构式 SMILES 串（可选，SmilesText 渲染为骨架式） */
  smiles?: string;
  /** SMILES 结构名称（如 "乙醇"） */
  smiles_caption?: string;
  /** 出处（流水线填写的 JSON：{"resourceIds":[…]}），导入后写入题目 source_ref */
  source_ref?: string;
}

export interface QuestionGenerationSpec {
  question_type: QuestionType;
  count: number;
  difficulty?: Difficulty | null;
}

/** 被跳过的参考文件（后端 reason 码 → 前端本地化文案） */
export interface SkippedReference {
  name: string;
  /** text_extract_failed | file_not_found | unsupported_format | read_failed |
   *  too_many_files | model_not_multimodal */
  reason: string;
  detail?: string;
}

export interface QbankGenerationRequestPayload {
  exam_id: string;
  stream_session_id: string;
  model_config_id?: string | null;
  max_questions: number;
  specs: QuestionGenerationSpec[];
  difficulty?: Difficulty | null;
  topic_hint?: string | null;
  based_on_existing: boolean;
  language?: string | null;
  /** 资源库参考文件（后端直读提取文本 / 页面图） */
  reference_file_ids?: string[];
  /** 前端临时上传的参考文件（base64，不落资源库） */
  reference_files_base64?: { name: string; base64: string }[];
  /** 知识点（从现有题目 tags 选择或手动输入） */
  knowledge_points?: string[];
}

/** 任务状态（与后端 GenerationTaskStatus 对齐） */
export type QbankGenerationTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** 后台出题任务视图（后端 GenerationTaskView） */
export interface QbankGenerationTask {
  id: string;
  examId: string;
  status: QbankGenerationTaskStatus;
  drafts: GeneratedQuestionDraft[];
  rejectedCount: number;
  rejectionReasons: string[];
  skippedReferences: SkippedReference[];
  usedReferenceCount: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  authoringResult?: {
    document: QuestionDocumentV2;
    job_id: string;
    version: number;
    model_route?: unknown;
  } | null;
}

/** 是否终态（终态任务不再变化） */
export function isTerminalTaskStatus(status: QbankGenerationTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** 全局事件：从完成通知等处一键打开指定题目集的 AI 出题草稿审阅面板 */
export const QBANK_OPEN_GENERATION_DRAFT_EVENT = 'qbank:open-generation-draft';

export interface QbankOpenGenerationDraftDetail {
  examId: string;
  taskId?: string | null;
  jobId?: string | null;
}

export type PendingAuthoringDraftOrigin = 'ai_generation' | 'chat_import' | 'file_import';

/** 题目集待确认草稿视图（带来源归属，供 QBank 空态/顶栏展示与一键确认入库） */
export interface PendingAuthoringDraftView {
  job_id: string;
  version: number;
  question_count: number;
  status: string;
  created_at?: string;
  origin: PendingAuthoringDraftOrigin;
  /** 人类可读的来源说明（主题/参考资料/知识点/模型或导入来源） */
  sourceLabel: string;
  /** 关联的后台出题任务 ID（由 AI 出题生成时存在） */
  taskId?: string | null;
  /** 草稿内全部题目的 local_id，支持一键全部确认入库 */
  localIds?: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function collectSourceNames(metadata: Record<string, unknown>, request: Record<string, unknown> | null): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    const str = readNonEmptyString(raw);
    if (!str || seen.has(str)) return;
    seen.add(str);
    names.push(str);
  };

  if (Array.isArray(metadata.sources)) {
    for (const item of metadata.sources) {
      const rec = asRecord(item);
      if (!rec) continue;
      push(rec.name ?? rec.file_name ?? rec.title);
    }
  }
  if (request && Array.isArray(request.reference_files_base64)) {
    for (const item of request.reference_files_base64) {
      const rec = asRecord(item);
      if (!rec) continue;
      push(rec.name);
    }
  }
  return names;
}

/**
 * 从 authoring draft 的 `metadata`（或 generation task 的 `authoringResult.model_route`）
 * 提取稳定的来源类型与可读归属文案，避免出现无归属的“待确认草稿”。
 */
export function extractAuthoringDraftAttribution(
  metadata: unknown,
  options?: { defaultOrigin?: PendingAuthoringDraftOrigin },
): { origin: PendingAuthoringDraftOrigin; sourceLabel: string } {
  const meta = asRecord(metadata);
  const rawSource = readNonEmptyString(meta?.source);
  const request = asRecord(meta?.request);
  const hasChatSession = Boolean(readNonEmptyString(meta?.chat_session_id));

  let origin: PendingAuthoringDraftOrigin;
  if (rawSource === 'ai_generation') {
    origin = 'ai_generation';
  } else if (rawSource === 'chat_import' || hasChatSession) {
    origin = 'chat_import';
  } else if (options?.defaultOrigin) {
    origin = options.defaultOrigin;
  } else {
    origin = 'file_import';
  }

  const parts: string[] = [];
  const topicHint = readNonEmptyString(request?.topic_hint);
  if (topicHint) {
    const clipped = topicHint.length > 36 ? `${topicHint.slice(0, 36)}…` : topicHint;
    parts.push(`主题：${clipped}`);
  }

  const sourceNames = meta ? collectSourceNames(meta, request) : [];
  if (sourceNames.length > 0) {
    const shown = sourceNames.slice(0, 2).join('、');
    const suffix = sourceNames.length > 2 ? ` 等 ${sourceNames.length} 份资料` : '';
    parts.push(`资料：${shown}${suffix}`);
  }

  if (request && Array.isArray(request.knowledge_points)) {
    const kps = request.knowledge_points
      .map((item) => readNonEmptyString(item))
      .filter((item): item is string => Boolean(item));
    if (kps.length > 0) {
      const shown = kps.slice(0, 3).join('、');
      parts.push(`知识点：${shown}${kps.length > 3 ? '…' : ''}`);
    }
  }

  if (parts.length === 0 && request?.based_on_existing === true) {
    parts.push('基于现有题库变式');
  }

  if (parts.length === 0) {
    const primaryModel = asRecord(meta?.primary_model);
    const modelLabel = readNonEmptyString(primaryModel?.name) ?? readNonEmptyString(primaryModel?.model);
    if (origin === 'ai_generation') {
      parts.push(modelLabel ? `AI 智能出题 · ${modelLabel}` : 'AI 智能出题');
    } else if (origin === 'chat_import') {
      parts.push('对话导入');
    } else {
      parts.push(modelLabel ? `文档/试卷识别导入 · ${modelLabel}` : '文档/试卷识别导入');
    }
  }

  return {
    origin,
    sourceLabel: parts.join(' · '),
  };
}

/** 提取后台 AI 出题任务的数量与归属信息（用于完成通知与状态卡片）。 */
export function extractGenerationTaskAttribution(task: QbankGenerationTask): {
  count: number;
  sourceLabel: string;
} {
  const docCount = Array.isArray(task.authoringResult?.document?.questions)
    ? task.authoringResult!.document.questions.length
    : 0;
  const count = task.drafts.length > 0 ? task.drafts.length : docCount;
  const { sourceLabel } = extractAuthoringDraftAttribution(task.authoringResult?.model_route, {
    defaultOrigin: 'ai_generation',
  });
  return { count, sourceLabel };
}
