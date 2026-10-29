import React from 'react';
import BatchPracticeWorkspace from '@/components/practice/BatchPracticeWorkspace';
import MistakeRedoOverlay from '@/features/learning-hub/mistakeBook/MistakeRedoOverlay';
import { setCtInvokeHandlers } from '../mocks/tauri-core-mock';
import { ExamShell } from './ExamShell';
import type { PracticeDraft, PracticeAttempt, PracticeResult } from '@/api/practiceApi';

const seed: PracticeDraft = {
  id: 'practice-ct',
  scope_id: 'exam-ct',
  paper_id: null,
  title: '综合练习',
  mode: 'sequential',
  questions: [
    {
      id: 'q1',
      exam_id: 'exam-ct',
      content: '已知函数 $f(x)=x^2+2x$，求 $f(2)$ 的值。',
      question_type: 'single_choice',
      options: [
        { key: 'A', content: '4' },
        { key: 'B', content: '8' },
        { key: 'C', content: '12' },
      ],
      answer: 'B',
      explanation: '代入计算 $f(2)=4+4=8$。',
      structured_data: null,
      tags: [],
      status: 'new',
      is_favorite: false,
      is_bookmarked: false,
      attempt_count: 0,
      correct_count: 0,
      source_type: 'manual',
      created_at: '',
      updated_at: '',
      images: [],
    },
    {
      id: 'q2',
      exam_id: 'exam-ct',
      content: '请说明函数的单调性，并给出判断过程。',
      question_type: 'short_answer',
      answer: '利用导数判断。',
      explanation: '求导后判断正负。',
      tags: [],
      status: 'new',
      is_favorite: false,
      is_bookmarked: false,
      attempt_count: 0,
      correct_count: 0,
      source_type: 'manual',
      created_at: '',
      updated_at: '',
      images: [],
    },
  ],
  answers: {},
  marked_ids: [],
  current_index: 0,
  elapsed_seconds: 0,
  duration_seconds: null,
  deadline: null,
  revision: 1,
  created_at: '',
  updated_at: '',
};

export function BatchPracticeHarness({ mistakeOverlay = false }: { mistakeOverlay?: boolean }) {
  const [overlayOpen, setOverlayOpen] = React.useState(false);
  const initialized = React.useRef(false);
  if (!initialized.current) {
    initialized.current = true;
    let draft = structuredClone(seed);
    let completed: PracticeAttempt | null = null;
    setCtInvokeHandlers({
      qbank_get_practice: (_command, payload) => payload?.submitted ? completed : draft,
      qbank_get_question: () => ({ is_favorite: false, ai_feedback: null }),
      qbank_get_history: () => [],
      qbank_resume_practice_grading: () => null,
      qbank_grade_practice_manually: (_command, payload) => {
        if (!completed) throw new Error('No submitted practice');
        completed = {
          ...completed,
          status: 'completed',
          results: completed.results.map((result): PracticeResult => result.question_id === payload?.questionId
            ? { ...result, status: payload.correct ? 'correct' : 'incorrect', is_correct: Boolean(payload.correct), score: payload.correct ? 100 : 0 }
            : result),
        };
        return completed;
      },
      qbank_save_practice: (_command, payload) => {
        draft = {
          ...draft,
          ...(payload?.request as Partial<PracticeDraft>),
          revision: draft.revision + 1,
        };
        return draft;
      },
      qbank_submit_practice: () => {
        completed = ({
          ...draft,
          status: 'grading',
          submitted_at: '',
          origin_device_id: 'ct',
          results: draft.questions.map((q) => ({
            question_id: q.id,
            status: !draft.answers[q.id]
              ? 'unanswered'
              : q.question_type === 'short_answer'
                ? 'pending'
                : draft.answers[q.id] === q.answer
                  ? 'correct'
                  : 'incorrect',
            is_correct:
              !draft.answers[q.id] || q.question_type === 'short_answer'
                ? null
                : draft.answers[q.id] === q.answer,
            score: null,
            feedback: null,
            error: null,
            submission_id: 's',
            source_available: true,
          })),
        }) satisfies PracticeAttempt;
        return completed;
      },
    });
  }
  return (
    <ExamShell>
      {mistakeOverlay ? <>
        <button type="button" onClick={() => setOverlayOpen(true)}>打开错题重做</button>
        {overlayOpen && <MistakeRedoOverlay questionIds={['q1', 'q2']} examNames={{}} practiceId="practice-ct" onClose={() => setOverlayOpen(false)} />}
      </> : <BatchPracticeWorkspace practiceId="practice-ct" onBack={() => {}} />}
    </ExamShell>
  );
}
