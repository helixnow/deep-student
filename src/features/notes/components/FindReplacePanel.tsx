import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlass, X, CaretUp, CaretDown, CaretRight } from '@phosphor-icons/react';
import { Input } from '@/components/ui/shad/Input';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import type { CrepeEditorApi } from '@/components/crepe/types';
import { editorViewCtx } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/prose/view';
import {
  searchHighlightKey,
  collectSearchMatches,
  replaceAllSearchMatches,
  type SearchMatch,
  type SearchOptions,
} from '@/components/crepe/plugins/searchHighlight';

export interface FindReplacePanelProps {
  editorApi: CrepeEditorApi | null;
  onClose: () => void;
  className?: string;
  /** 只读 / 阅读模式：保留查找，禁用替换 */
  readOnly?: boolean;
  initialQuery?: string;
  /**
   * 外部重新聚焦信号：值变化（如自增计数）时把焦点拉回查找输入框并全选。
   * 宿主在面板已打开时再次收到 Cmd/Ctrl+F 可用此 prop 恢复 VS Code 式聚焦行为。
   */
  focusSignal?: number;
}

/** 退场过渡时长，与 --dropdown-close-dur（150ms）对齐；含少量缓冲防止过早卸载 */
const EXIT_FALLBACK_MS = 180;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const FindReplacePanel: React.FC<FindReplacePanelProps> = ({
  editorApi,
  onClose,
  className,
  readOnly = false,
  initialQuery = '',
  focusSignal,
}) => {
  const { t } = useTranslation(['notes', 'common']);
  const [findText, setFindText] = useState(initialQuery);
  const [replaceText, setReplaceText] = useState('');
  const [isReplaceMode, setIsReplaceMode] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isClosing, setIsClosing] = useState(false);
  /** 替换成功的短暂反馈文案（约 1.6s 后淡出复位） */
  const [replaceFeedback, setReplaceFeedback] = useState<string | null>(null);

  const findInputRef = useRef<HTMLInputElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  /**
   * 上一次活跃匹配的文档位置锚点。查询词 / 选项变化导致 effect 重跑时，
   * 用它把活跃匹配保持在原位置附近，而不是每次都跳回第一条。
   */
  const lastActiveFromRef = useRef<number | null>(null);

  // Focus input on mount
  useEffect(() => {
    findInputRef.current?.focus();
  }, []);

  // 外部触发重新聚焦（面板已开时宿主再次 Cmd/Ctrl+F）
  useEffect(() => {
    if (focusSignal === undefined) return;
    const input = findInputRef.current;
    input?.focus();
    input?.select();
  }, [focusSignal]);

  useEffect(() => {
    setFindText(initialQuery);
  }, [initialQuery]);

  // 进入只读时收起替换区
  useEffect(() => {
    if (readOnly) setIsReplaceMode(false);
  }, [readOnly]);

  /** 带退场动画的关闭；reduced-motion 下立即关闭 */
  const requestClose = useCallback(() => {
    if (closeTimerRef.current !== null) return;
    if (prefersReducedMotion()) {
      onClose();
      return;
    }
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, EXIT_FALLBACK_MS);
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
    };
  }, []);

  const showReplaceFeedback = useCallback((count: number) => {
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    setReplaceFeedback(
      t('notes:findReplace.replacedCount', { count, defaultValue: '已替换 {{count}} 处' }),
    );
    feedbackTimerRef.current = window.setTimeout(() => {
      feedbackTimerRef.current = null;
      setReplaceFeedback(null);
    }, 1600);
  }, [t]);

  /** 获取底层 ProseMirror EditorView */
  const getView = useCallback((): EditorView | null => {
    const crepe = editorApi?.getCrepe();
    if (!crepe) return null;
    let view: EditorView | null = null;
    try {
      crepe.editor.action((ctx) => {
        view = ctx.get(editorViewCtx);
      });
    } catch {
      return null;
    }
    return view;
  }, [editorApi]);

  /** 推送查询状态到高亮插件，返回最新匹配列表 */
  const syncHighlight = useCallback((
    query: string,
    activeIndex: number,
    options: SearchOptions = {},
  ): SearchMatch[] => {
    const view = getView();
    if (!view) return [];
    const matches = collectSearchMatches(view.state.doc, query, options);
    const clamped = matches.length === 0 ? 0 : ((activeIndex % matches.length) + matches.length) % matches.length;
    view.dispatch(view.state.tr.setMeta(searchHighlightKey, {
      query,
      activeIndex: clamped,
      caseSensitive: options.caseSensitive ?? false,
      wholeWord: options.wholeWord ?? false,
    }));
    setMatchCount(matches.length);
    setCurrentIndex(clamped);
    lastActiveFromRef.current = matches[clamped]?.from ?? lastActiveFromRef.current;
    return matches;
  }, [getView]);

  /** 滚动当前匹配到视口中央（不抢输入框焦点） */
  const scrollToMatch = useCallback((match: SearchMatch | undefined) => {
    if (!match) return;
    const view = getView();
    if (!view) return;
    try {
      const domInfo = view.domAtPos(match.from);
      const el = domInfo.node instanceof HTMLElement
        ? domInfo.node
        : domInfo.node.parentElement;
      el?.scrollIntoView({
        block: 'center',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    } catch {
      // 位置失效时忽略（文档可能正被编辑）
    }
  }, [getView]);

  // 查询词 / 选项变化时实时刷新高亮；活跃匹配尽量停留在上次位置附近
  useEffect(() => {
    const options: SearchOptions = { caseSensitive, wholeWord };
    const view = getView();
    const matches = view ? collectSearchMatches(view.state.doc, findText, options) : [];
    let targetIndex = 0;
    const anchor = lastActiveFromRef.current;
    if (anchor !== null && matches.length > 0) {
      const nearest = matches.findIndex((m) => m.from >= anchor);
      targetIndex = nearest === -1 ? matches.length - 1 : nearest;
    }
    syncHighlight(findText, targetIndex, options);
    if (findText && matches.length > 0) {
      scrollToMatch(matches[targetIndex]);
    }
  }, [findText, caseSensitive, wholeWord, getView, syncHighlight, scrollToMatch]);

  // 卸载时清除高亮
  useEffect(() => {
    return () => {
      const view = getView();
      if (view) {
        view.dispatch(view.state.tr.setMeta(searchHighlightKey, { query: '' }));
      }
    };
  }, [getView]);

  const navigate = useCallback((direction: 1 | -1) => {
    if (!findText) return;
    const view = getView();
    if (!view) return;
    const options: SearchOptions = { caseSensitive, wholeWord };
    const matches = collectSearchMatches(view.state.doc, findText, options);
    if (matches.length === 0) return;
    const next = ((currentIndex + direction) % matches.length + matches.length) % matches.length;
    syncHighlight(findText, next, options);
    scrollToMatch(matches[next]);
  }, [findText, caseSensitive, wholeWord, currentIndex, getView, syncHighlight, scrollToMatch]);

  // F3 / Shift+F3 全局导航；面板已开时 Cmd/Ctrl+F 重新聚焦查找框（VS Code 行为）
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F3') {
        e.preventDefault();
        navigate(e.shiftKey ? -1 : 1);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        const input = findInputRef.current;
        input?.focus();
        input?.select();
      }
    };
    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, [navigate]);

  /** 替换当前匹配 */
  const handleReplaceCurrent = useCallback(() => {
    if (readOnly || !findText) return;
    const view = getView();
    if (!view) return;
    const options: SearchOptions = { caseSensitive, wholeWord };
    const matches = collectSearchMatches(view.state.doc, findText, options);
    if (matches.length === 0) return;
    const idx = Math.min(currentIndex, matches.length - 1);
    const target = matches[idx];
    view.dispatch(view.state.tr.insertText(replaceText, target.from, target.to));
    // 替换后重新计算，停留在同一索引（即下一个匹配）
    const remaining = collectSearchMatches(view.state.doc, findText, options);
    const nextIdx = remaining.length === 0 ? 0 : Math.min(idx, remaining.length - 1);
    syncHighlight(findText, nextIdx, options);
    scrollToMatch(remaining[nextIdx]);
    showReplaceFeedback(1);
  }, [readOnly, findText, replaceText, caseSensitive, wholeWord, currentIndex, getView, syncHighlight, scrollToMatch, showReplaceFeedback]);

  /** 全部替换（从后往前避免位置偏移） */
  const handleReplaceAll = useCallback(() => {
    if (readOnly || !findText) return;
    const view = getView();
    if (!view) return;
    const options: SearchOptions = { caseSensitive, wholeWord };
    const matches = collectSearchMatches(view.state.doc, findText, options);
    if (matches.length === 0) return;
    const tr = replaceAllSearchMatches(view.state.tr, matches, replaceText);
    view.dispatch(tr);
    syncHighlight(findText, 0, options);
    showReplaceFeedback(matches.length);
  }, [readOnly, findText, replaceText, caseSensitive, wholeWord, getView, syncHighlight, showReplaceFeedback]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      // Enter / Shift+Enter 在匹配间正反向循环
      e.preventDefault();
      navigate(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      requestClose();
    }
  };

  /** 替换输入框：Enter 替换当前，Cmd/Ctrl+Enter 全部替换 */
  const handleReplaceKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        handleReplaceAll();
      } else {
        handleReplaceCurrent();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      requestClose();
    }
  };

  const replaceDisabled = readOnly || !findText || matchCount === 0;
  const panelLabel = t('notes:findReplace.panelLabel');
  const findLabel = t('notes:findReplace.findLabel');
  const replaceLabel = t('notes:findReplace.replaceLabel');
  const noMatchText = t('notes:findReplace.noMatch', { defaultValue: '无匹配结果' });

  return (
    <div
      role="search"
      aria-label={panelLabel}
      data-state={isClosing ? 'closing' : 'open'}
      className={cn(
        // 贴编辑区顶部的紧凑内联条形面板（VS Code / Typora 风格），挂载点为编辑区 relative 容器
        'absolute inset-x-0 top-0 z-40 flex flex-col overflow-hidden',
        'border-b border-border/60 bg-background',
        'shadow-[0_2px_8px_hsl(var(--shadow-base)/0.06)]',
        // 入场：token 驱动 drop-in（150ms，--dropdown-ease；ui-motion 已内置 reduced-motion 降级）。
        // 关闭时必须移除：其 fill-mode: both 的终态会压过退场过渡。
        !isClosing && 'ui-drop-in',
        // 退场：显式属性过渡（禁止 transition:all），reduced-motion 下由 requestClose 直接关闭
        'transition-[opacity,transform] duration-150 ease-[var(--dropdown-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none',
        isClosing && 'pointer-events-none -translate-y-1 opacity-0',
        className,
      )}
    >
      <div className="flex items-center gap-1 px-2 py-1">
        {!readOnly ? (
          <NotionButton
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => setIsReplaceMode(!isReplaceMode)}
            title={isReplaceMode
              ? t('notes:findReplace.hideReplace')
              : t('notes:findReplace.showReplace')}
            aria-label={isReplaceMode
              ? t('notes:findReplace.hideReplace')
              : t('notes:findReplace.showReplace')}
            aria-expanded={isReplaceMode}
          >
            {/* 收起时向右、展开时向下（Typora/VS Code 语义） */}
            <CaretRight
              className={cn(
                'h-4 w-4 transition-transform duration-150 ease-[var(--dropdown-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none',
                isReplaceMode && 'rotate-90',
              )}
            />
          </NotionButton>
        ) : (
          <div className="w-6 flex-shrink-0" />
        )}

        <div className="relative flex w-full min-w-0 max-w-[320px] items-center">
          <MagnifyingGlass className="absolute left-2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            ref={findInputRef}
            className={cn(
              'h-7 text-xs pl-7 bg-transparent border-none focus-visible:ring-1',
              findText && matchCount === 0 &&
                'focus-visible:ring-[hsl(var(--destructive)/0.45)]',
            )}
            placeholder={t('notes:findReplace.findPlaceholder')}
            aria-label={findLabel}
            aria-invalid={findText.length > 0 && matchCount === 0}
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        {(findText || replaceFeedback) && (
          <span
            className={cn(
              'flex-shrink-0 whitespace-nowrap px-1 text-[10px] tabular-nums',
              replaceFeedback
                ? 'text-[hsl(var(--success))]'
                : matchCount > 0
                  ? 'text-muted-foreground'
                  : 'text-[hsl(var(--destructive)/0.85)]',
            )}
            aria-live="polite"
            aria-atomic="true"
          >
            {replaceFeedback ? (
              <span key={replaceFeedback} className="inline-block ui-rise-in">
                {replaceFeedback}
              </span>
            ) : matchCount > 0 ? (
              // key 驱动计数变化时的 150ms token 化上浮动画（reduced-motion 已由 ui-motion 降级）
              <span key={`${currentIndex}-${matchCount}`} className="inline-block ui-rise-in">
                {`${currentIndex + 1}/${matchCount}`}
              </span>
            ) : (
              <span key="no-match" className="inline-block ui-rise-in">
                {noMatchText}
              </span>
            )}
          </span>
        )}

        <div className="ml-auto flex flex-shrink-0 items-center gap-0.5">
          <NotionButton
            variant="ghost"
            size="sm"
            className={cn('h-6 w-6 p-0 text-[10px] font-semibold', caseSensitive && 'bg-[var(--interactive-selected)] text-foreground')}
            onClick={() => setCaseSensitive((v) => !v)}
            title={t('notes:editor.case_sensitive')}
            aria-label={t('notes:editor.case_sensitive')}
            aria-pressed={caseSensitive}
          >
            Aa
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="sm"
            className={cn('h-6 w-6 p-0 text-[10px] font-semibold', wholeWord && 'bg-[var(--interactive-selected)] text-foreground')}
            onClick={() => setWholeWord((v) => !v)}
            title={t('notes:editor.whole_word')}
            aria-label={t('notes:editor.whole_word')}
            aria-pressed={wholeWord}
          >
            W
          </NotionButton>
          <div className="mx-0.5 h-4 w-[1px] bg-border/60" aria-hidden="true" />
          <NotionButton
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => navigate(-1)}
            disabled={matchCount === 0}
            title={t('notes:findReplace.prev')}
            aria-label={t('notes:findReplace.prev')}
          >
            <CaretUp className="h-4 w-4" />
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => navigate(1)}
            disabled={matchCount === 0}
            title={t('notes:findReplace.next')}
            aria-label={t('notes:findReplace.next')}
          >
            <CaretDown className="h-4 w-4" />
          </NotionButton>
          <div className="mx-0.5 h-4 w-[1px] bg-border/60" aria-hidden="true" />
          <NotionButton
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
            onClick={requestClose}
            aria-label={t('common:close')}
          >
            <X className="h-4 w-4" />
          </NotionButton>
        </div>
      </div>

      {isReplaceMode && !readOnly && (
        <div className="ui-rise-in flex items-center gap-1 px-2 pb-1">
          <div className="w-6 flex-shrink-0" /> {/* Spacer to align with input above */}
          <div className="relative flex w-full min-w-0 max-w-[320px] items-center">
            <Input
              className="h-7 text-xs pl-2 bg-transparent border-none focus-visible:ring-1"
              placeholder={t('notes:findReplace.replacePlaceholder')}
              aria-label={replaceLabel}
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              onKeyDown={handleReplaceKeyDown}
            />
          </div>
          <div className="flex flex-shrink-0 items-center gap-1">
            <NotionButton
              variant="secondary"
              size="sm"
              className="h-6 text-[10px] px-2 ui-press"
              disabled={replaceDisabled}
              onClick={handleReplaceCurrent}
            >
              {t('notes:findReplace.replace')}
            </NotionButton>
            <NotionButton
              variant="secondary"
              size="sm"
              className="h-6 text-[10px] px-2 ui-press"
              disabled={replaceDisabled}
              onClick={handleReplaceAll}
            >
              {t('notes:findReplace.replaceAll')}
            </NotionButton>
          </div>
        </div>
      )}
    </div>
  );
};
