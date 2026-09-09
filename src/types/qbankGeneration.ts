/**
 * 题目集 AI 出题 - 共享类型（2026-09-09 后台任务化）
 *
 * 与 Rust `qbank_generation::types` / `task_repo` 对齐。
 * 单独成文件是为了让 store / hook / 面板都能引用而不产生循环依赖。
 */

import type { QuestionType, Difficulty } from '@/api/questionBankApi';

export interface GeneratedQuestionOption {
  key: string;
  content: string;
}

export interface GeneratedQuestionDraft {
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
}

/** 是否终态（终态任务不再变化） */
export function isTerminalTaskStatus(status: QbankGenerationTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
