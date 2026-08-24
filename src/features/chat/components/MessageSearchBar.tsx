import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CaretDown, CaretUp, MagnifyingGlass, X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/utils/cn';
import Z_INDEX from '@/config/zIndex';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

export interface MessageSearchBarProps {
  placement?: 'floating' | 'header';
  query: string;
  matchCount: number;
  activeMatchIndex: number;
  activeMessageId: string | null;
  activeOccurrenceIndex: number;
  onQueryChange: (query: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  onNavigate: (messageId: string, occurrenceIndex: number) => void | Promise<unknown>;
}

export const MessageSearchBar: React.FC<MessageSearchBarProps> = ({
  placement = 'floating',
  query,
  matchCount,
  activeMatchIndex,
  activeMessageId,
  activeOccurrenceIndex,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
  onNavigate,
}) => {
  const { t } = useTranslation('chatV2');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // 📱 Android 系统返回键 = 关闭搜索条（自绘浮层，协调器 Radix 兜底覆盖不到），
  // 与 InputBarUI 组合面板、InlineImageViewer 的 overlay 语义一致。
  useEffect(() => {
    return registerBackHandler(() => {
      // 保活守卫：宿主视图在被隐藏的保活层里仍保持挂载时，搜索条也随之滞留——
      // 此时不消费返回键、不触发关闭回调，交还给当前活跃视图
      // （对照 EnhancedPdfViewer 的同款守卫）。visibility:hidden 不清布局盒
      // （getClientRects 仍有返回值），需单独查 computed 值。
      const el = rootRef.current;
      if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
      if (window.getComputedStyle(el).visibility === 'hidden') return false;
      onCloseRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
  }, []);

  // 两种形态都 portal 在宿主视图之外（body / 桌面壳顶栏），视图被切走
  // （visibility:hidden）时不会随之隐藏；监听全局视图切换事件收起搜索条，
  // 避免悬浮在新视图上方（对照 InputBarUI 组合面板的处理）。
  useEffect(() => {
    const handleViewSwitched = () => onCloseRef.current();
    window.addEventListener('app:view-switched', handleViewSwitched);
    return () => window.removeEventListener('app:view-switched', handleViewSwitched);
  }, []);

  useEffect(() => {
    if (!activeMessageId) return;
    void onNavigateRef.current(activeMessageId, activeOccurrenceIndex);
  }, [activeMessageId, activeOccurrenceIndex, query]);

  const hasMatches = matchCount > 0;
  const resultLabel = query.trim()
    ? hasMatches
      ? t('messageList.search.results', {
          current: activeMatchIndex + 1,
          count: matchCount,
        })
      : t('messageList.search.noResults')
    : '';

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) onPrevious();
      else onNext();
    }
  };

  const isHeaderPlacement = placement === 'header';
  const hasQuery = query.trim().length > 0;

  const content = (
    <div
      ref={rootRef}
      className={cn(
        isHeaderPlacement
          ? 'relative flex h-full min-w-0 w-full items-center justify-end'
          : 'pointer-events-none fixed right-4 top-2 z-[1101] flex w-[min(32rem,calc(100vw-2rem))] justify-end md:right-8 md:top-1',
      )}
      style={isHeaderPlacement ? undefined : { zIndex: Z_INDEX.desktopTitlebar + 1 }}
      data-no-drag
      data-slot="message-search-bar"
    >
      <div
        role="search"
        className={cn(
          'pointer-events-auto ml-auto flex h-12 min-w-0 w-full max-w-md items-center gap-2 overflow-hidden',
          // The header placement is portaled outside `.chat-v2`, so keep the
          // chat token while falling back to the global shell radius there.
          'rounded-[var(--chat-radius-pill,var(--radius-shell-toolbar,16px))] border border-border/70',
          'bg-background/95 transition-[border-color,box-shadow] duration-150',
          'focus-within:border-ring/70 focus-within:ring-2 focus-within:ring-ring/20',
          isHeaderPlacement ? 'px-3 shadow-sm' : 'px-3 shadow-floating backdrop-blur-sm',
        )}
      >
        <MagnifyingGlass
          size={20}
          weight="regular"
          aria-hidden="true"
          className="ml-1 shrink-0 text-muted-foreground"
        />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('messageList.search.placeholder')}
          aria-label={t('messageList.search.open')}
          // 📱 16px 输入契约：15px 在 iOS WKWebView 聚焦时会触发页面自动放大
          className="min-w-0 flex-1 appearance-none bg-transparent px-1.5 py-1.5 text-[15px] [@media(pointer:coarse)]:text-[16px] text-foreground outline-none placeholder:text-muted-foreground/70"
        />
        {hasQuery ? (
          <>
            <span
              aria-live="polite"
              className={cn(
                'shrink-0 whitespace-nowrap px-1 text-sm tabular-nums',
                hasMatches ? 'text-muted-foreground' : 'text-destructive',
              )}
            >
              {resultLabel}
            </span>
            <div aria-hidden="true" className="mx-0.5 h-7 w-px bg-border/70" />
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={onPrevious}
              disabled={!hasMatches}
              aria-label={t('messageList.search.previous')}
              title={t('messageList.search.previous')}
              className="!size-11 !rounded-full text-muted-foreground hover:text-foreground"
            >
              <CaretUp size={16} weight="bold" aria-hidden="true" />
            </DsButton>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={onNext}
              disabled={!hasMatches}
              aria-label={t('messageList.search.next')}
              title={t('messageList.search.next')}
              className="!size-11 !rounded-full text-muted-foreground hover:text-foreground"
            >
              <CaretDown size={16} weight="bold" aria-hidden="true" />
            </DsButton>
            <div aria-hidden="true" className="mx-0.5 h-7 w-px bg-border/70" />
          </>
        ) : null}
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={onClose}
          aria-label={t('messageList.search.close')}
          title={t('messageList.search.close')}
          className="!size-8 !rounded-full text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:!size-11"
        >
          <X size={17} weight="regular" aria-hidden="true" />
        </DsButton>
      </div>
    </div>
  );

  // header 形态由调用方（MessageList）portal 到桌面壳顶栏插槽；floating 形态
  // 用 fixed 定位，必须 portal 到 body——MobileSlidingLayout 的 track 常驻
  // transform（containing block 约定），in-tree fixed 会以 track 为包含块错位。
  if (isHeaderPlacement) return content;
  return createPortal(content, document.body);
};
