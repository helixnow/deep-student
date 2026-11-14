import type { TFunction } from 'i18next';

export type SpaceCountdownKind = 'future' | 'today' | 'passed';
export type SpaceCountdownUrgency = 'calm' | 'soon' | 'urgent';

export interface SpaceCountdownResult {
  examDate: string;
  daysDiff: number;
  kind: SpaceCountdownKind;
  urgency: SpaceCountdownUrgency;
  label: string;
  dotColorClass: string;
}

const ISO_DATE_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const EMOJI_STRIP_RE = /\p{Extended_Pictographic}|\uFE0F|\u200D/gu;

export function stripEmojiText(input: string | null | undefined): string {
  if (!input) return '';
  return input.replace(EMOJI_STRIP_RE, '').replace(/\s{2,}/g, ' ').trim();
}

function parseLocalMidnight(examDate: string): Date | null {
  const match = ISO_DATE_PREFIX_RE.exec(examDate.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function resolveUrgency(daysDiff: number): {
  urgency: SpaceCountdownUrgency;
  dotColorClass: string;
} {
  if (daysDiff > 30) {
    return { urgency: 'calm', dotColorClass: 'bg-emerald-500' };
  }
  if (daysDiff >= 8) {
    return { urgency: 'soon', dotColorClass: 'bg-amber-500' };
  }
  return { urgency: 'urgent', dotColorClass: 'bg-rose-500' };
}

function resolveTranslatedCountdownLabel(
  daysDiff: number,
  t?: TFunction,
): string {
  if (daysDiff === 0) {
    const translated = t?.('chatV2:studySpace.badges.countdownToday');
    if (translated && !translated.includes('countdownToday')) {
      return translated;
    }
    return 'D-Day';
  }
  if (daysDiff > 0) {
    const translated = t?.('chatV2:studySpace.badges.countdownDays', { days: daysDiff });
    if (translated && !translated.includes('countdownDays') && !translated.includes('{{')) {
      return translated;
    }
    return `D-${daysDiff}`;
  }
  const absDays = Math.abs(daysDiff);
  const translated = t?.('chatV2:studySpace.badges.countdownPassed', { days: absDays });
  if (translated && !translated.includes('countdownPassed') && !translated.includes('{{')) {
    return translated;
  }
  return `D+${absDays}`;
}

export function computeSpaceCountdown(
  examDate: string | null | undefined,
  now: Date = new Date(),
  t?: TFunction,
): SpaceCountdownResult | null {
  if (!examDate || typeof examDate !== 'string') return null;
  const targetMidnight = parseLocalMidnight(examDate);
  if (!targetMidnight) return null;

  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msPerDay = 86_400_000;
  const daysDiff = Math.round((targetMidnight.getTime() - todayMidnight.getTime()) / msPerDay);
  const kind: SpaceCountdownKind =
    daysDiff > 0 ? 'future' : daysDiff === 0 ? 'today' : 'passed';
  const { urgency, dotColorClass } = resolveUrgency(daysDiff);
  const label = resolveTranslatedCountdownLabel(daysDiff, t);

  return {
    examDate: examDate.trim().slice(0, 10),
    daysDiff,
    kind,
    urgency,
    label,
    dotColorClass,
  };
}

export function formatSpaceCountdown(
  examDate: string | null | undefined,
  options?: { now?: Date; t?: TFunction },
): SpaceCountdownResult | null {
  return computeSpaceCountdown(examDate, options?.now, options?.t);
}
