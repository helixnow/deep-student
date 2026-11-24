import type { TFunction } from 'i18next';

export interface FocusDurationParts {
  totalSeconds: number;
  minutes: number;
  remSeconds: number;
  roundedMinutes: number;
}

type FocusLocalePrefix = 'pomodoro.stats' | 'pomodoro.today';

/**
 * Derive deterministic minute & exact second components from a raw focus duration in seconds.
 */
export function getFocusDurationParts(seconds: number): FocusDurationParts {
  const totalSeconds = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  return {
    totalSeconds,
    minutes: Math.floor(totalSeconds / 60),
    remSeconds: totalSeconds % 60,
    roundedMinutes: Math.round(totalSeconds / 60),
  };
}

/**
 * Format focus duration concisely for UI badges while preserving sub-minute seconds accuracy.
 */
export function formatFocusDisplay(
  seconds: number,
  t: TFunction<any>,
  prefix: FocusLocalePrefix = 'pomodoro.stats',
): string {
  const { totalSeconds, roundedMinutes } = getFocusDurationParts(seconds);
  if (totalSeconds === 0) {
    return t(`${prefix}.minutes`, { value: 0 });
  }
  if (totalSeconds < 60) {
    return t(`${prefix}.seconds`, { value: totalSeconds, defaultValue: `${totalSeconds} 秒` });
  }
  if (roundedMinutes < 60) {
    return t(`${prefix}.minutes`, { value: roundedMinutes });
  }
  return t(`${prefix}.hours`, { value: (roundedMinutes / 60).toFixed(1) });
}

/**
 * Format exact minutes + seconds breakdown for hover tooltips so rounded labels remain verifiable.
 */
export function formatFocusTooltip(
  seconds: number,
  t: TFunction<any>,
  prefix: FocusLocalePrefix = 'pomodoro.stats',
): string {
  const { minutes, remSeconds } = getFocusDurationParts(seconds);
  if (minutes === 0) {
    return t(`${prefix}.exactSeconds`, {
      seconds: remSeconds,
      defaultValue: `累计专注 ${remSeconds} 秒`,
    });
  }
  return t(`${prefix}.exactMinutesSeconds`, {
    minutes,
    seconds: remSeconds,
    defaultValue: `累计专注 ${minutes} 分 ${remSeconds} 秒`,
  });
}
