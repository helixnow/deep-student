/** Wire enums follow question_repo.rs; `__De` permits serde's externally tagged map form. */
export type QuestionType = 'single_choice' | 'multiple_choice' | 'indefinite_choice' | 'fill_blank'
  | 'short_answer' | 'essay' | 'calculation' | 'proof' | 'true_false' | 'matching' | 'ordering'
  | 'numeric' | 'other';
export type Difficulty = 'easy' | 'medium' | 'hard' | 'very_hard';
export type QuestionStatus = 'new' | 'in_progress' | 'mastered' | 'review';
export type SourceType = 'ocr' | 'imported' | 'ai_generated' | 'manual';

const QUESTION_TYPES: readonly QuestionType[] = ['single_choice', 'multiple_choice', 'indefinite_choice',
  'fill_blank', 'short_answer', 'essay', 'calculation', 'proof', 'true_false', 'matching', 'ordering',
  'numeric', 'other'];
const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard', 'very_hard'];
const STATUSES: readonly QuestionStatus[] = ['new', 'in_progress', 'mastered', 'review'];
const SOURCE_TYPES: readonly SourceType[] = ['ocr', 'imported', 'ai_generated', 'manual'];

/** serde `__De`: either the string or `{variant: null}`. */
export function enumValue(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const keys = Object.keys(input);
    if (keys.length === 1 && (input as Record<string, unknown>)[keys[0]!] === null) return keys[0]!;
  }
  return null;
}

export function enumList(input: readonly unknown[] | null | undefined): string[] | null {
  if (input == null) return null;
  return input.map(enumValue).filter((value): value is string => value !== null);
}

/** QuestionType::from_str: strips separators, lowercases, unknown -> other. */
export function questionTypeFrom(value: string): QuestionType {
  const compact = [...value].filter(char => char !== '_' && char !== '-' && !/\s/u.test(char)).join('').toLowerCase();
  switch (compact) {
    case 'singlechoice': return 'single_choice';
    case 'multiplechoice': return 'multiple_choice';
    case 'indefinitechoice': return 'indefinite_choice';
    case 'fillblank': return 'fill_blank';
    case 'shortanswer': return 'short_answer';
    case 'essay': return 'essay';
    case 'calculation': return 'calculation';
    case 'proof': return 'proof';
    case 'truefalse': return 'true_false';
    case 'matching': return 'matching';
    case 'ordering': return 'ordering';
    case 'numeric': return 'numeric';
    default: return 'other';
  }
}
export function difficultyFrom(value: string): Difficulty {
  return value === 'easy' || value === 'hard' || value === 'very_hard' ? value : 'medium';
}
export function statusFrom(value: string): QuestionStatus {
  return value === 'in_progress' || value === 'mastered' || value === 'review' ? value : 'new';
}
export function sourceTypeFrom(value: string): SourceType {
  return value === 'imported' || value === 'ai_generated' || value === 'manual' ? value : 'ocr';
}

function normalize(value: unknown, allowed: readonly string[], fallback: string): string {
  const raw = enumValue(value);
  return raw !== null && allowed.includes(raw) ? raw : fallback;
}
export function toQuestionType(value: unknown): QuestionType {
  return normalize(value, QUESTION_TYPES, 'other') as QuestionType;
}
export function toDifficulty(value: unknown): Difficulty {
  return normalize(value, DIFFICULTIES, 'medium') as Difficulty;
}
export function toStatus(value: unknown): QuestionStatus {
  return normalize(value, STATUSES, 'new') as QuestionStatus;
}
export function toSourceType(value: unknown): SourceType {
  return normalize(value, SOURCE_TYPES, 'ocr') as SourceType;
}
export const SEARCH_SORT_BY = ['relevance', 'created_desc', 'created_asc', 'updated_desc'] as const;
export type SearchSortBy = typeof SEARCH_SORT_BY[number];
export function toSearchSortBy(value: unknown): SearchSortBy {
  const raw = enumValue(value);
  return raw === 'created_desc' || raw === 'created_asc' || raw === 'updated_desc' ? raw : 'relevance';
}
