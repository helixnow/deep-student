import type React from 'react';
import {
  Shuffle,
  ListNumbers,
  ArrowCounterClockwise,
  Tag,
  BookOpen,
  Target,
  Clock,
} from '@phosphor-icons/react';
import type {
  Difficulty,
  PracticeMode,
  QuestionStatus,
} from '@/api/questionBankApi';
import type { ExtendedQuestionType } from '@/components/question-types';

export const DIFFICULTY_CONFIG: Record<Difficulty, { dot: string }> = {
  easy: { dot: 'bg-success/75' },
  medium: { dot: 'bg-warning/75' },
  hard: { dot: 'bg-warning' },
  very_hard: { dot: 'bg-destructive/80' },
};

export const STATUS_CONFIG: Record<QuestionStatus, { dot: string }> = {
  new: { dot: 'bg-muted-foreground/35' },
  in_progress: { dot: 'bg-primary' },
  mastered: { dot: 'bg-success' },
  review: { dot: 'bg-warning' },
};

export const MODE_ICON: Record<PracticeMode, React.ElementType> = {
  sequential: ListNumbers,
  random: Shuffle,
  review_first: ArrowCounterClockwise,
  review_only: ArrowCounterClockwise,
  by_tag: Tag,
  timed: Clock,
  mock_exam: BookOpen,
  daily: Target,
  paper: Target,
};

/** Maps snake_case PracticeMode to camelCase i18n key */
export const MODE_I18N_KEY: Record<PracticeMode, string> = {
  sequential: 'sequential',
  random: 'random',
  review_first: 'reviewFirst',
  review_only: 'reviewOnly',
  by_tag: 'byTag',
  timed: 'timed',
  mock_exam: 'mockExam',
  daily: 'daily',
  paper: 'paper',
};

/** Maps snake_case Difficulty to camelCase i18n key */
export const DIFFICULTY_I18N_KEY: Record<Difficulty, string> = {
  easy: 'easy',
  medium: 'medium',
  hard: 'hard',
  very_hard: 'veryHard',
};

/** Maps snake_case QuestionStatus to camelCase i18n key */
export const STATUS_I18N_KEY: Record<QuestionStatus, string> = {
  new: 'new',
  in_progress: 'inProgress',
  mastered: 'mastered',
  review: 'review',
};

/** Maps snake_case QuestionType to camelCase i18n key */
export const QUESTION_TYPE_I18N_KEY: Record<ExtendedQuestionType, string> = {
  single_choice: 'singleChoice',
  multiple_choice: 'multipleChoice',
  indefinite_choice: 'indefiniteChoice',
  fill_blank: 'fillBlank',
  short_answer: 'shortAnswer',
  essay: 'essay',
  calculation: 'calculation',
  proof: 'proof',
  other: 'other',
  true_false: 'trueFalse',
  matching: 'matching',
  ordering: 'ordering',
  numeric: 'numeric',
};

/**
 * 做题视图共享动效关键帧。
 * scale / translate 使用独立属性（与 ui-motion.css 一致），不覆盖 inline transform。
 */
export const QBANK_KEYFRAMES = `
  @keyframes fadeSlideUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes qbankPopIn {
    0% { scale: 0.4; opacity: 0; }
    60% { scale: 1.18; opacity: 1; }
    100% { scale: 1; opacity: 1; }
  }
  @keyframes qbankShake {
    0%, 100% { translate: 0 0; }
    20% { translate: -4px 0; }
    40% { translate: 4px 0; }
    60% { translate: -3px 0; }
    80% { translate: 3px 0; }
  }
  .qbank-anim-pop {
    animation: qbankPopIn 320ms var(--dropdown-ease, cubic-bezier(0.22, 1, 0.36, 1)) both;
  }
  .qbank-anim-shake {
    animation: qbankShake 340ms ease-in-out both;
  }
  @media (prefers-reduced-motion: reduce) {
    .qbank-anim-pop, .qbank-anim-shake { animation: none; }
  }
`;
