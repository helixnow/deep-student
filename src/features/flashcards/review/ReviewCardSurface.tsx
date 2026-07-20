/**
 * 复习卡面：单实例模板卡面 + 3D 翻面/入场动画（内容同步切换，动画纯装饰，
 * 尊重 prefers-reduced-motion）。
 *
 * 滑动评分（可选）：翻面后卡片支持拖动跟手 + 边缘方向色带 + 松手评分飞出；
 * 手势逻辑见 hooks/useSwipeRating（左=Again 右=Good 上=Easy 下=Hard）。
 */
import React from 'react';
import { ArrowClockwise } from '@phosphor-icons/react';
import { AnkiTemplateCardFace } from '@/components/anki/AnkiTemplateCardFace';
import type { CustomAnkiTemplate } from '@/types';
import { cn } from '@/utils/cn';
import { hasValidCloze, renderClozeText } from '../cloze';
import type {
  SwipeDirection,
  SwipeRatingState,
  UseSwipeRatingResult,
} from '../hooks/useSwipeRating';
import { toRenderableReviewCard } from '../reviewCardEditFields';
import type { ReviewCard } from '../store/fsrsReviewStore';

/** 滑动方向 → 边缘色带视觉（四色语义与评分按钮 tone 对齐） */
const SWIPE_BANDS: Record<SwipeDirection, {
  ratingLabelKey: string;
  strip: string;
  pill: string;
  pillPosition: string;
}> = {
  left: {
    ratingLabelKey: 'session.again',
    strip: 'inset-y-2 left-1 w-1 bg-destructive',
    pill: 'bg-destructive/15 text-destructive',
    pillPosition: 'left-3 top-1/2 -translate-y-1/2',
  },
  down: {
    ratingLabelKey: 'session.hard',
    strip: 'inset-x-2 bottom-1 h-1 bg-amber-500',
    pill: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    pillPosition: 'bottom-3 left-1/2 -translate-x-1/2',
  },
  right: {
    ratingLabelKey: 'session.good',
    strip: 'inset-y-2 right-1 w-1 bg-emerald-500',
    pill: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    pillPosition: 'right-3 top-1/2 -translate-y-1/2',
  },
  up: {
    ratingLabelKey: 'session.easy',
    strip: 'inset-x-2 top-1 h-1 bg-sky-500',
    pill: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
    pillPosition: 'top-3 left-1/2 -translate-x-1/2',
  },
};

/** 拖动跟手 / 飞出 / 回弹的内联变换（回弹与飞出的过渡由 .wb-fc-swipe-card 提供） */
function swipeTransformStyle(state: SwipeRatingState): React.CSSProperties {
  if (state.flyout) {
    const transform = {
      left: 'translate(-130%, 6%) rotate(-12deg)',
      right: 'translate(130%, 6%) rotate(12deg)',
      up: 'translate(0, -130%)',
      down: 'translate(0, 130%)',
    }[state.flyout];
    return { transform, opacity: 0 };
  }
  if (state.dragging) {
    return {
      transform: `translate(${state.dx * 0.9}px, ${state.dy * 0.9}px) rotate(${state.dx * 0.04}deg)`,
      transition: 'none',
    };
  }
  return {};
}

export interface ReviewCardSurfaceProps {
  card: ReviewCard;
  template: CustomAnkiTemplate | null;
  templateLoading: boolean;
  flipped: boolean;
  disabled: boolean;
  onFlip: () => void;
  frontLabel: string;
  backLabel: string;
  flipAriaLabel: string;
  flipHint: string;
  noFrontText: string;
  noBackText: string;
  /** 滑动评分手势（可选；不传则行为与原版一致） */
  swipe?: UseSwipeRatingResult;
  /** 手势是否生效（翻面后且未在评分/编辑中） */
  swipeEnabled?: boolean;
  /** 色带评分标签翻译（key 属于 flashcards 命名空间） */
  ratingLabel?: (key: string) => string;
  /**
   * ACR 实体锚点值（`flashcards:{ankiCardId}`）：挂到卡面容器供
   * agentFlash 定位当前复习卡（agent 改卡/入队后的实体级演出）。
   */
  agentEntityId?: string;
}

type AnimPhase = 'none' | 'a' | 'b';

export const ReviewCardSurface: React.FC<ReviewCardSurfaceProps> = ({
  card,
  template,
  templateLoading,
  flipped,
  disabled,
  onFlip,
  frontLabel,
  backLabel,
  flipAriaLabel,
  flipHint,
  noFrontText,
  noBackText,
  swipe,
  swipeEnabled = false,
  ratingLabel,
  agentEntityId,
}) => {
  const side = flipped ? 'back' : 'front';
  const isCloze = hasValidCloze(card.text);
  const fallbackText = isCloze
    ? renderClozeText(card.text ?? '', flipped)
    : flipped
      ? card.back || card.text || ''
      : card.front || card.text || '';
  const renderCard = React.useMemo(() => toRenderableReviewCard(card), [card]);

  // 交替使用两个等价动画类以重启 CSS 动画；卡片切换时用入场动画而非翻面动画。
  const cardKey = `${card.id}:${card.ankiCardId ?? ''}`;
  const [flipAnim, setFlipAnim] = React.useState<AnimPhase>('none');
  const [enterAnim, setEnterAnim] = React.useState<AnimPhase>('none');
  const prevRef = React.useRef<{ cardKey: string; side: 'front' | 'back' } | null>(null);
  React.useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { cardKey, side };
    if (!prev) return;
    if (prev.cardKey !== cardKey) {
      setEnterAnim((phase) => (phase === 'a' ? 'b' : 'a'));
      return;
    }
    if (prev.side !== side) {
      setFlipAnim((phase) => (phase === 'a' ? 'b' : 'a'));
    }
  }, [cardKey, side]);

  // 卡面内容是否可滚动：不可滚动时四方向手势全交给指针（touch-action:none）；
  // 可滚动时纵向让位给内容滚动（pan-y），上/下滑评分退化为鼠标/触控板专属，按钮兜底。
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [contentFits, setContentFits] = React.useState(true);
  React.useEffect(() => {
    if (!swipe) return;
    const node = scrollRef.current;
    if (!node) return;
    const measure = () => {
      setContentFits(node.scrollHeight <= node.clientHeight + 1);
    };
    const frame = requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [swipe, cardKey, side, template, templateLoading]);

  const swipeState = swipe?.state ?? null;
  const band = swipeState && swipeState.dragging && swipeState.direction
    ? SWIPE_BANDS[swipeState.direction]
    : null;

  return (
    <div
      className="wb-fc-card-stage relative"
      data-agent-entity={agentEntityId}
      {...(swipe
        ? swipeEnabled
          ? swipe.handlers
          // 手势关闭时仍保留 click 捕获：吞掉拖动收尾的合成 click，避免误翻面
          : { onClickCapture: swipe.handlers.onClickCapture }
        : {})}
      style={swipe && swipeEnabled
        ? { touchAction: contentFits ? 'none' : 'pan-y' }
        : undefined}
    >
      <div
        className={cn('flex min-h-0 min-w-0 flex-1', swipe && 'wb-fc-swipe-card')}
        style={swipeState ? swipeTransformStyle(swipeState) : undefined}
      >
        <div
          ref={scrollRef}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          aria-busy={templateLoading}
          aria-label={flipAriaLabel}
          aria-keyshortcuts="Space"
          onClick={disabled ? undefined : onFlip}
          data-side={side}
          data-enter={enterAnim === 'none' ? undefined : enterAnim}
          className={cn(
            'wb-fc-card relative flex min-h-[16rem] min-w-0 flex-1 cursor-pointer flex-col overflow-auto',
            'px-5 py-6 text-center',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            disabled && 'cursor-default opacity-70',
          )}
        >
          <span className="wb-fc-card-side-label">
            {flipped ? backLabel : frontLabel}
          </span>
          <div
            data-flip={flipAnim === 'none' ? undefined : flipAnim}
            className="wb-fc-card-face flex min-h-0 min-w-0 flex-1 flex-col"
          >
            {/* 不再对 iframe 设 max-h 上限：iframe 高度随内容自适应，
                超长卡片由外层 .wb-fc-card（overflow-auto）统一滚动。
                此前 55vh 截断 + pointer-events-none 会让 iframe 内部滚动不可达，
                长内容（图片/长文/公式）被裁掉且无法查看。 */}
            <AnkiTemplateCardFace
              card={renderCard}
              template={template}
              side={side}
              compact={false}
              fallbackText={fallbackText}
              emptyText={flipped ? noBackText : noFrontText}
              className="pointer-events-none flex min-h-0 flex-1 items-center justify-center"
            />
          </div>
          <span className="wb-fc-card-flip-hint" aria-hidden="true">
            <ArrowClockwise size={13} />
            {flipHint}
          </span>
        </div>
      </div>

      {/* 拖动方向色带反馈（边缘细条 + 评分标签），随进度增强 */}
      {band && swipeState ? (
        <>
          <div
            aria-hidden="true"
            className={cn('pointer-events-none absolute rounded-full', band.strip)}
            style={{ opacity: 0.25 + swipeState.progress * 0.75 }}
          />
          {ratingLabel ? (
            <span
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute rounded-md px-2 py-0.5 text-xs font-medium',
                band.pill,
                band.pillPosition,
              )}
              style={{ opacity: 0.4 + swipeState.progress * 0.6 }}
            >
              {ratingLabel(band.ratingLabelKey)}
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
};
