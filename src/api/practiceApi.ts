import { invoke } from '@tauri-apps/api/core';
import type { Question as StoredQuestion, GeneratedPaper } from '@/stores/questionBankStore';

export type GradingMode = 'immediate' | 'on_submit';
export interface PracticeDraft {
  id: string;
  scope_id: string;
  paper_id: string | null;
  title: string;
  mode: string;
  questions: StoredQuestion[];
  answers: Record<string, string>;
  marked_ids: string[];
  current_index: number;
  elapsed_seconds: number;
  duration_seconds: number | null;
  deadline: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface PracticeResult {
  question_id: string;
  status: 'unanswered' | 'pending' | 'failed' | 'correct' | 'incorrect' | 'partial';
  is_correct: boolean | null;
  score: number | null;
  feedback: string | null;
  error: string | null;
  submission_id: string | null;
  source_available: boolean;
}
export interface PracticeAttempt {
  id: string;
  scope_id: string;
  paper_id: string | null;
  title: string;
  mode: string;
  questions: StoredQuestion[];
  answers: Record<string, string>;
  marked_ids: string[];
  results: PracticeResult[];
  elapsed_seconds: number;
  duration_seconds: number | null;
  status: string;
  origin_device_id: string;
  created_at: string;
  submitted_at: string;
}
export interface CreatePracticeRequest {
  id: string;
  scope_id: string;
  title: string;
  mode: string;
  question_ids: string[];
  paper_id?: string;
  duration_seconds?: number;
  started_at?: string;
  attempt_id?: string;
  start_question_id?: string;
}
export interface PracticeSummary {
  id: string;
  title: string;
  mode: string;
  paper_id: string | null;
  question_count: number;
  answered_count: number;
  correct_count: number;
  pending_count: number;
  status: string;
  updated_at: string;
}
export const practiceApi = {
  create: (request: CreatePracticeRequest) =>
    invoke<PracticeDraft>('qbank_create_practice', { request }),
  getDraft: (id: string) => invoke<PracticeDraft>('qbank_get_practice', { id, submitted: false }),
  getAttempt: (id: string) =>
    invoke<PracticeAttempt>('qbank_get_practice', { id, submitted: true }),
  save: (draft: PracticeDraft) =>
    invoke<PracticeDraft>('qbank_save_practice', {
      request: {
        id: draft.id,
        revision: draft.revision,
        answers: draft.answers,
        marked_ids: draft.marked_ids,
        current_index: draft.current_index,
        elapsed_seconds: draft.elapsed_seconds,
      },
    }),
  submit: (id: string, revision: number) =>
    invoke<PracticeAttempt>('qbank_submit_practice', { id, revision }),
  list: async (scopeId: string, submitted: boolean): Promise<PracticeSummary[]> => {
    const rows: PracticeSummary[] = [];
    let page: PracticeSummary[];
    do {
      page = await invoke<PracticeSummary[]>('qbank_list_practices', { scopeId, submitted, offset: rows.length });
      rows.push(...page);
    } while (page.length === 200);
    return rows;
  },
  remove: (id: string, submitted: boolean) =>
    invoke<void>('qbank_delete_practice', { id, submitted }),
  retry: (id: string, questionId: string) =>
    invoke<PracticeAttempt>('qbank_retry_practice_grading', { id, questionId }),
  grade: (id: string, questionId: string, correct: boolean) =>
    invoke<PracticeAttempt>('qbank_grade_practice_manually', { id, questionId, correct }),
  resumeGrading: () => invoke<void>('qbank_resume_practice_grading'),
  papers: (examId: string) => invoke<GeneratedPaper[]>('qbank_list_papers', { examId }),
  paper: (id: string) => invoke<GeneratedPaper>('qbank_get_paper', { id }),
  updatePaper: (id: string, title: string | null, deleted: boolean) =>
    invoke<void>('qbank_update_paper', { id, title, deleted }),
};

export function newPracticeId(): string {
  return `practice_${crypto.randomUUID()}`;
}

/** Default ordering is not an answer until the learner interacts with it. */
export function isAnswered(answer: string | undefined): boolean {
  return Boolean(answer?.trim());
}
