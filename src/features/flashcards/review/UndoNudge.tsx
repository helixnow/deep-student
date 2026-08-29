/**
 * 评分后的瞬态撤销提示条：评分落地后在评分栏上方短暂出现，
 * 显示刚才的评分档位并提供一键撤销入口（与工具栏撤销/快捷键 Z 等价）。
 *
 * 纯前端瞬态 UI：TTL 到期自动隐藏；撤销栈栈顶变化（再评一张 / 撤销 / 会话重置）
 * 时重置。文案走 t(key, { defaultValue })，locale 文件里的正式词条见
 * docs/dev/wave2-E-r5-06-review-ux.md。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowCounterClockwise } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import type { FsrsRating } from '../store/fsrsReviewStore';

/** 提示条自动隐藏时长；期间随时可用 Z / 工具栏撤销 */
const NUDGE_TTL_MS = 8_000;

const RATING_LABEL_KEYS: Record<FsrsRating, string> = {
  1: 'session.again',
  2: 'session.hard',
  3: 'session.good',
  4: 'session.easy',
};

export interface UndoNudgeProps {
  /** 撤销栈栈顶回执 logId；变为新的非空值时显示提示条并重置 TTL */
  receiptId: string | null;
  /** 刚评的档位；外部 reconcile 剔除回执后可能缺失，此时显示通用文案 */
  rating: FsrsRating | null;
  busy: boolean;
  onUndo: () => void;
}

export const UndoNudge: React.FC<UndoNudgeProps> = ({
  receiptId,
  rating,
  busy,
  onUndo,
}) => {
  const { t } = useTranslation('flashcards');
  // 初始化为挂载时的栈顶：只对「挂载后新增的评分」弹提示，
  // 会话中途重挂载（如切 tab 回来）不重复打扰。
  const seenIdRef = React.useRef<string | null>(receiptId);
  const [shownId, setShownId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (receiptId === seenIdRef.current) return undefined;
    seenIdRef.current = receiptId;
    if (!receiptId) {
      setShownId(null);
      return undefined;
    }
    setShownId(receiptId);
    const timer = window.setTimeout(() => {
      setShownId((current) => (current === receiptId ? null : current));
    }, NUDGE_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [receiptId]);

  if (!shownId || shownId !== receiptId) return null;

  const message = rating != null
    ? t('review.undoNudgeRated', {
        defaultValue: 'Rated {{rating}}',
        rating: t(RATING_LABEL_KEYS[rating]),
      })
    : t('review.undoNudgeGeneric', { defaultValue: 'Review recorded' });

  return (
    <div
      role="status"
      className="flex flex-shrink-0 items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/40 py-1 pl-3 pr-1 text-xs text-muted-foreground"
    >
      <span className="min-w-0 truncate">{message}</span>
      <DsButton
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={onUndo}
        aria-keyshortcuts="Z"
        className="shrink-0 gap-1.5 text-xs [@media(pointer:coarse)]:!min-h-11"
      >
        <ArrowCounterClockwise size={13} aria-hidden="true" />
        {t('session.undo')}
        <kbd aria-hidden="true" className="wb-fc-keycap">Z</kbd>
      </DsButton>
    </div>
  );
};
