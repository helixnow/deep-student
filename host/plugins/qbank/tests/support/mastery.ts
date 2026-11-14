/** 非掌握度用例的最小对照：真实 review 组合由 mastery-submit/questions 的 mastery fixture 覆盖。 */
import type { MasteryRecorder } from '../../src/question-service.ts';

export function fakeMasteryRecorder(): MasteryRecorder {
  return {
    recordQbankAnswerWithConn: () => ({}),
    recordQbankVerdictCorrectionWithConn: () => ({}),
    syncLearnerProfile: () => undefined,
  };
}

export function fakeMasteryService(): Record<string, unknown> {
  return { mastery: fakeMasteryRecorder() };
}
