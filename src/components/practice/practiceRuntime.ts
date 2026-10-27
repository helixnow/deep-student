/** Read-only summaries for Agent observation; answers never enter this registry. */
export type PracticeRuntimeSummary = {
  id: string;
  examId: string;
  mode: string;
  gradingMode: 'on_submit';
  questionCount: number;
  answeredCount: number;
  currentQuestionId: string | null;
  isSubmitted: boolean;
  scoreSummary: null | {
    correctCount: number;
    wrongCount: number;
    unansweredCount: number;
    pendingCount: number;
  };
};
const surfaces = new Map<string, PracticeRuntimeSummary>();
export function setPracticeRuntime(key: string, summary: PracticeRuntimeSummary | null) {
  if (summary) surfaces.set(key, summary);
  else surfaces.delete(key);
}
export function getPracticeRuntimes(examId: string | null): PracticeRuntimeSummary[] {
  return [...surfaces.values()].filter((s) => s.examId === examId);
}
