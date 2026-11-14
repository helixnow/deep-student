import type { Difficulty, QuestionStatus, QuestionType, SourceType } from '../api.ts';

export function questionTypeFromStr(value: string): QuestionType {
  const compact = value.replace(/[_\-\p{White_Space}]/gu, '').toLowerCase();
  const types: Record<string, QuestionType> = {
    singlechoice: 'single_choice', multiplechoice: 'multiple_choice', indefinitechoice: 'indefinite_choice',
    fillblank: 'fill_blank', shortanswer: 'short_answer', essay: 'essay', calculation: 'calculation',
    proof: 'proof', truefalse: 'true_false', matching: 'matching', ordering: 'ordering', numeric: 'numeric',
  };
  return Object.hasOwn(types, compact) ? types[compact]! : 'other';
}
export function difficultyFromStr(value: string): Difficulty {
  return value === 'easy' || value === 'hard' || value === 'very_hard' ? value : 'medium';
}
export function questionStatusFromStr(value: string): QuestionStatus {
  return value === 'in_progress' || value === 'mastered' || value === 'review' ? value : 'new';
}
export function sourceTypeFromStr(value: string): SourceType {
  return value === 'imported' || value === 'ai_generated' || value === 'manual' ? value : 'ocr';
}
