import i18n from '@/i18n';

/** Stored as string values in DSTU metadata.props; no inference from legacy keys. */
export const LEARNING_PROP_KEYS = {
  course: 'study_course',
  chapter: 'study_chapter',
  mastery: 'study_mastery',
  reviewDate: 'study_review_date',
} as const;

export const MASTERY_STATES = ['unstarted', 'learning', 'needs-review', 'mastered'] as const;
export type MasteryState = typeof MASTERY_STATES[number];
export interface NoteLearningProps {
  course?: string;
  chapter?: string;
  mastery?: MasteryState;
  /** Local calendar date, YYYY-MM-DD; never converted to UTC. */
  reviewDate?: string;
}
export type LearningField = keyof NoteLearningProps;

export function localCalendarDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  return year > 0 && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function isLearningPropValue(field: LearningField, raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 512) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return false;
  if (field === 'mastery') return MASTERY_STATES.includes(raw as MasteryState);
  if (field === 'reviewDate') return isCalendarDate(raw);
  return true;
}

export function readNoteLearningProps(props: Record<string, unknown>): NoteLearningProps {
  const result: Record<string, string> = {};
  for (const field of Object.keys(LEARNING_PROP_KEYS) as LearningField[]) {
    const raw = props[LEARNING_PROP_KEYS[field]];
    if (isLearningPropValue(field, raw)) result[field] = raw as string;
  }
  return result as NoteLearningProps;
}

/** Only explicitly edited fields change; unknown keys and invalid old values survive. */
export function updateNoteLearningProps(
  props: Record<string, unknown>,
  changes: Partial<Record<LearningField, string>>,
): Record<string, unknown> {
  const next = { ...props };
  for (const field of Object.keys(changes) as LearningField[]) {
    const value = changes[field] ?? '';
    if (value !== '' && !isLearningPropValue(field, value)) throw new Error(i18n.t('notes:learning.errors.invalid_value'));
    const key = LEARNING_PROP_KEYS[field];
    if (Object.keys(next).some((existing) => existing !== key && existing.trim().toLowerCase() === key)) {
      throw new Error(i18n.t('notes:learning.errors.legacy_key_conflict', { key }));
    }
    if (value === '') delete next[key];
    else next[key] = value;
  }
  if (Object.keys(next).length > 32 && Object.keys(next).length > Object.keys(props).length) {
    throw new Error(i18n.t('notes:learning.errors.too_many'));
  }
  return next;
}

export type NoteLearningView = 'list' | 'status' | 'review';
export interface LearningViewNote {
  id: string;
  name: string;
  type: string;
  metadata?: Record<string, unknown>;
}

export function learningPropsFromMetadata(metadata?: Record<string, unknown>): Record<string, unknown> {
  const props = metadata?.props;
  return props && typeof props === 'object' && !Array.isArray(props) ? props as Record<string, unknown> : {};
}

/** Scalar props and tags affect the explorer even when the title/path did not change. */
export function sameNoteLearningMetadata(left?: Record<string, unknown>, right?: Record<string, unknown>): boolean {
  const a = learningPropsFromMetadata(left);
  const b = learningPropsFromMetadata(right);
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length || keys.some((key) => !Object.hasOwn(b, key) || !Object.is(a[key], b[key]))) return false;
  const aTags = Array.isArray(left?.tags) ? left.tags : [];
  const bTags = Array.isArray(right?.tags) ? right.tags : [];
  return aTags.length === bTags.length && aTags.every((tag, index) => tag === bTags[index]);
}

/** All views derive from the same host list; review includes overdue and the next seven days. */
export function selectLearningViewNotes<T extends LearningViewNote>(
  notes: readonly T[], view: NoteLearningView, now = new Date(),
): T[] {
  const end = new Date(now);
  end.setDate(end.getDate() + 7);
  const through = localCalendarDate(end);
  return notes.filter((note) => {
    if (note.type !== 'note') return false;
    if (view !== 'review') return true;
    const { reviewDate } = readNoteLearningProps(learningPropsFromMetadata(note.metadata));
    return Boolean(reviewDate && reviewDate <= through);
  }).sort((a, b) => {
    const left = readNoteLearningProps(learningPropsFromMetadata(a.metadata));
    const right = readNoteLearningProps(learningPropsFromMetadata(b.metadata));
    if (view === 'review') return left.reviewDate!.localeCompare(right.reviewDate!) || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });
}
