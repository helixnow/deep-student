import React, { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { BellSlash, Question, X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { cn } from '@/utils/cn';
import { ThreadContentShell } from './ThreadContentShell';

export type MobileEmptyBadgeSnoozeScope = 'today' | 'week';

export interface MobileEmptyBadgeSnoozeRecord {
  scope: MobileEmptyBadgeSnoozeScope;
  until: number;
}

export const MOBILE_EMPTY_BADGE_SNOOZE_KEY = 'chat.mobileEmptyBadgeSnooze';

const snoozeListeners = new Set<() => void>();
let cachedRawSnooze: string | null | undefined;
let cachedParsedSnooze: MobileEmptyBadgeSnoozeRecord | null = null;

function notifySnoozeListeners(): void {
  for (const listener of snoozeListeners) {
    listener();
  }
}

/**
 * 计算气泡静默截止时间戳（本地时区）：
 * - `today`：次日 00:00:00（当天不再显示）
 * - `week`：下周一 00:00:00（本周不再显示，按周一至周日自然周计算）
 */
export function computeMobileEmptyBadgeSnoozeUntil(
  scope: MobileEmptyBadgeSnoozeScope,
  now: Date = new Date()
): number {
  if (scope === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).getTime();
  }
  const dayOfWeek = now.getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const daysUntilNextMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + daysUntilNextMonday,
    0,
    0,
    0,
    0
  ).getTime();
}

function readBadgeSnoozeSnapshot(): MobileEmptyBadgeSnoozeRecord | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(MOBILE_EMPTY_BADGE_SNOOZE_KEY);
  } catch {
    return null;
  }

  if (raw === cachedRawSnooze) {
    if (cachedParsedSnooze && cachedParsedSnooze.until <= Date.now()) {
      clearMobileEmptyBadgeSnooze(false);
      return null;
    }
    return cachedParsedSnooze;
  }

  cachedRawSnooze = raw;
  if (!raw) {
    cachedParsedSnooze = null;
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<MobileEmptyBadgeSnoozeRecord>;
    if (
      (parsed.scope === 'today' || parsed.scope === 'week') &&
      typeof parsed.until === 'number' &&
      Number.isFinite(parsed.until) &&
      parsed.until > Date.now()
    ) {
      cachedParsedSnooze = { scope: parsed.scope, until: parsed.until };
      return cachedParsedSnooze;
    }
  } catch {
    /* 损坏的本地存储值直接忽略并清理 */
  }

  clearMobileEmptyBadgeSnooze(false);
  return null;
}

function subscribeBadgeSnooze(listener: () => void): () => void {
  snoozeListeners.add(listener);
  return () => {
    snoozeListeners.delete(listener);
  };
}

export function snoozeMobileEmptyBadge(
  scope: MobileEmptyBadgeSnoozeScope,
  now: Date = new Date()
): MobileEmptyBadgeSnoozeRecord {
  const record: MobileEmptyBadgeSnoozeRecord = {
    scope,
    until: computeMobileEmptyBadgeSnoozeUntil(scope, now),
  };
  const serialized = JSON.stringify(record);
  cachedRawSnooze = serialized;
  cachedParsedSnooze = record;
  try {
    localStorage.setItem(MOBILE_EMPTY_BADGE_SNOOZE_KEY, serialized);
  } catch {
    /* 隐私模式或写入受限时仍保留当前会话内存态 */
  }
  notifySnoozeListeners();
  return record;
}

export function clearMobileEmptyBadgeSnooze(shouldNotify = true): void {
  cachedRawSnooze = null;
  cachedParsedSnooze = null;
  try {
    localStorage.removeItem(MOBILE_EMPTY_BADGE_SNOOZE_KEY);
  } catch {
    /* 忽略清理异常 */
  }
  if (shouldNotify) {
    notifySnoozeListeners();
  }
}

export interface MobileEmptyStateToggleProps {
  title: React.ReactNode;
  brandIcon: React.ReactNode;
  renderCard: () => React.ReactNode;
  /** 当存在今日到期任务时，角标采用轻主色强调提示 */
  hasAccent?: boolean;
  /** 会话切换时自动收起，恢复默认安静的空态欢迎语 */
  resetKey?: string | null;
  className?: string;
  contentClassName?: string;
  titleId?: string;
}

const EASE_OUT_QUART = [0.22, 1, 0.36, 1] as const;

/**
 * 移动端空会话交互式欢迎舞台：
 * - 默认仅居中展示品牌 Logo（右上角带 `?` 提示气泡）与欢迎语，保持首屏安静居中；
 * - 点击 Logo 后，欢迎语丝滑切换为今日冲刺 / 复习卡片，Logo 随整体高度平滑上移居中，
 *   角标旋转为 `×`；再次点击 Logo 平滑切回欢迎语；
 * - 展开卡片后可选择「当天不显示」或「本周不显示」气泡：选择后自动收起并隐藏收起态 `?` 气泡，
 *   静默期间主动点击 Logo 仍可打开卡片并随时恢复气泡。
 */
export const MobileEmptyStateToggle: React.FC<MobileEmptyStateToggleProps> = ({
  title,
  brandIcon,
  renderCard,
  hasAccent = false,
  resetKey,
  className,
  contentClassName,
  titleId,
}) => {
  const { t } = useTranslation('chatV2');
  const prefersReducedMotion = useReducedMotion();
  const [showCard, setShowCard] = useState(false);
  const activeSnooze = useSyncExternalStore(
    subscribeBadgeSnooze,
    readBadgeSnoozeSnapshot,
    () => null
  );
  const generatedTitleId = useId();
  const headingId = titleId ?? generatedTitleId;

  useEffect(() => {
    setShowCard(false);
  }, [resetKey]);

  // 跨天或跨周回到页面时刷新一次过期检查，让气泡自动恢复
  useEventRegistry(
    activeSnooze
      ? [
          {
            target: 'document',
            type: 'visibilitychange',
            listener: () => {
              if (document.visibilityState === 'visible' && activeSnooze.until <= Date.now()) {
                clearMobileEmptyBadgeSnooze();
              }
            },
          },
        ]
      : [],
    [activeSnooze]
  );

  const handleSnooze = (scope: MobileEmptyBadgeSnoozeScope) => {
    snoozeMobileEmptyBadge(scope);
    setShowCard(false);
  };

  const handleRestoreBadge = () => {
    clearMobileEmptyBadgeSnooze();
  };

  const isBadgeVisible = showCard || activeSnooze === null;

  const layoutTransition = prefersReducedMotion
    ? { duration: 0.01 }
    : { type: 'spring' as const, stiffness: 420, damping: 32, mass: 0.85 };

  const badgeTransition = prefersReducedMotion
    ? { duration: 0.01 }
    : { duration: 0.16, ease: EASE_OUT_QUART };

  return (
    <ThreadContentShell className={cn('flex min-h-full items-center', className)}>
      <section
        data-slot="thread-empty-state"
        aria-labelledby={headingId}
        className={cn(
          'flex w-full flex-col items-center justify-center gap-4 text-center',
          contentClassName
        )}
      >
        {/* 展开卡片时保留读屏标题，确保 section 的 aria-labelledby 始终有效 */}
        {showCard ? (
          <h2 id={headingId} className="sr-only">
            {title}
          </h2>
        ) : null}

        <motion.div
          layout="position"
          transition={layoutTransition}
          whileTap={prefersReducedMotion ? undefined : { scale: 0.92 }}
        >
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            data-slot="thread-empty-brand"
            data-testid="mobile-empty-logo-toggle"
            aria-expanded={showCard}
            aria-label={
              showCard
                ? t('messageList.empty.hideTodayCard')
                : t('messageList.empty.showTodayCard')
            }
            onClick={() => setShowCard((prev) => !prev)}
            className={cn(
              'relative !h-14 !w-14 overflow-visible rounded-2xl border transition-[background-color,border-color,box-shadow] duration-200',
              showCard
                ? 'border-primary/30 bg-primary/[0.08] shadow-[var(--shadow-shell-soft)]'
                : 'border-transparent bg-transparent hover:bg-[var(--interactive-hover)]'
            )}
          >
            <span
              className={cn(
                'flex items-center justify-center transition-transform duration-200',
                showCard && 'scale-95'
              )}
            >
              {brandIcon}
            </span>

            {/* 右上角提示气泡：未静默收起态为 `?`，展开态平滑切换为 `×`，静默收起态隐藏 */}
            <AnimatePresence initial={false}>
              {isBadgeVisible ? (
                <motion.span
                  key="badge-shell"
                  aria-hidden="true"
                  data-testid="mobile-empty-logo-badge"
                  initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.5 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.5 }}
                  transition={badgeTransition}
                  className={cn(
                    'pointer-events-none absolute -right-0.5 -top-0.5 flex h-5 w-5 items-center justify-center rounded-full border shadow-sm transition-colors duration-200',
                    showCard
                      ? 'border-border/80 bg-card text-foreground'
                      : hasAccent
                        ? 'border-primary/40 bg-primary/15 text-primary'
                        : 'border-border/80 bg-card text-muted-foreground'
                  )}
                >
                  <AnimatePresence mode="wait" initial={false}>
                    {showCard ? (
                      <motion.span
                        key="close"
                        initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.5, rotate: -45 }}
                        animate={{ opacity: 1, scale: 1, rotate: 0 }}
                        exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.5, rotate: 45 }}
                        transition={badgeTransition}
                        className="flex items-center justify-center"
                      >
                        <X size={11} weight="bold" />
                      </motion.span>
                    ) : (
                      <motion.span
                        key="question"
                        initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.5, rotate: 45 }}
                        animate={{ opacity: 1, scale: 1, rotate: 0 }}
                        exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.5, rotate: -45 }}
                        transition={badgeTransition}
                        className="flex items-center justify-center"
                      >
                        <Question size={12} weight="bold" />
                      </motion.span>
                    )}
                  </AnimatePresence>
                </motion.span>
              ) : null}
            </AnimatePresence>
          </DsButton>
        </motion.div>

        <div className="relative w-full">
          <AnimatePresence mode="popLayout" initial={false}>
            {showCard ? (
              <motion.div
                key="today-card"
                layout="position"
                initial={prefersReducedMotion ? false : { opacity: 0, y: 12, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.96 }}
                transition={
                  prefersReducedMotion
                    ? { duration: 0.01 }
                    : { type: 'spring', stiffness: 400, damping: 30, mass: 0.85 }
                }
                className="w-full text-left"
              >
                {renderCard()}

                <div
                  data-testid="mobile-empty-badge-snooze-bar"
                  className="mt-2.5 flex flex-wrap items-center justify-center gap-1.5 text-xs text-muted-foreground"
                >
                  <span className="inline-flex items-center gap-1 text-muted-foreground/80">
                    <BellSlash size={12} aria-hidden="true" />
                    {activeSnooze
                      ? activeSnooze.scope === 'week'
                        ? t('messageList.empty.badgeSnoozedWeek')
                        : t('messageList.empty.badgeSnoozedToday')
                      : t('messageList.empty.badgeSnoozeLabel')}
                  </span>
                  {activeSnooze ? (
                    <DsButton
                      variant="ghost"
                      size="sm"
                      data-testid="mobile-empty-snooze-restore"
                      onClick={handleRestoreBadge}
                      className="h-7 rounded-full border border-border/60 bg-background/50 px-2.5 text-xs font-normal text-muted-foreground hover:text-foreground"
                    >
                      {t('messageList.empty.badgeSnoozeRestore')}
                    </DsButton>
                  ) : (
                    <>
                      <DsButton
                        variant="ghost"
                        size="sm"
                        data-testid="mobile-empty-snooze-today"
                        onClick={() => handleSnooze('today')}
                        className="h-7 rounded-full border border-border/60 bg-background/50 px-2.5 text-xs font-normal text-muted-foreground hover:text-foreground"
                      >
                        {t('messageList.empty.badgeSnoozeToday')}
                      </DsButton>
                      <DsButton
                        variant="ghost"
                        size="sm"
                        data-testid="mobile-empty-snooze-week"
                        onClick={() => handleSnooze('week')}
                        className="h-7 rounded-full border border-border/60 bg-background/50 px-2.5 text-xs font-normal text-muted-foreground hover:text-foreground"
                      >
                        {t('messageList.empty.badgeSnoozeWeek')}
                      </DsButton>
                    </>
                  )}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="welcome"
                layout="position"
                initial={prefersReducedMotion ? false : { opacity: 0, y: -8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.96 }}
                transition={
                  prefersReducedMotion
                    ? { duration: 0.01 }
                    : { duration: 0.22, ease: EASE_OUT_QUART }
                }
                className="w-full"
              >
                <h2
                  id={headingId}
                  data-slot="thread-empty-primary-action"
                  className="text-balance text-2xl font-medium text-foreground"
                >
                  {title}
                </h2>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </section>
    </ThreadContentShell>
  );
};
