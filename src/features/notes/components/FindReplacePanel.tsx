import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlass, X, CaretUp, CaretDown } from '@phosphor-icons/react';
import { Input } from '@/components/ui/shad/Input';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import type { CrepeEditorApi } from '@/components/crepe/types';
import { editorViewCtx } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/prose/view';
import {
  searchHighlightKey,
  collectSearchMatches,
  type SearchMatch,
} from '@/components/crepe/plugins/searchHighlight';

interface FindReplacePanelProps {
  editorApi: CrepeEditorApi | null;
  onClose: () => void;
  className?: string;
}

export const FindReplacePanel: React.FC<FindReplacePanelProps> = ({
  editorApi,
  onClose,
  className
}) => {
  const { t } = useTranslation(['notes', 'common']);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [isReplaceMode, setIsReplaceMode] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);

  const findInputRef = useRef<HTMLInputElement>(null);

  // Focus input on mount
  useEffect(() => {
    findInputRef.current?.focus();
  }, []);

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
  const syncHighlight = useCallback((query: string, activeIndex: number): SearchMatch[] => {
    const view = getView();
    if (!view) return [];
    const matches = collectSearchMatches(view.state.doc, query);
    const clamped = matches.length === 0 ? 0 : ((activeIndex % matches.length) + matches.length) % matches.length;
    view.dispatch(view.state.tr.setMeta(searchHighlightKey, { query, activeIndex: clamped }));
    setMatchCount(matches.length);
    setCurrentIndex(clamped);
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
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch {
      // 位置失效时忽略（文档可能正被编辑）
    }
  }, [getView]);

  // 查询词变化时实时刷新高亮
  useEffect(() => {
    const matches = syncHighlight(findText, 0);
    if (findText && matches.length > 0) {
      scrollToMatch(matches[0]);
    }
  }, [findText, syncHighlight, scrollToMatch]);

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
    const matches = collectSearchMatches(view.state.doc, findText);
    if (matches.length === 0) return;
    const next = ((currentIndex + direction) % matches.length + matches.length) % matches.length;
    syncHighlight(findText, next);
    scrollToMatch(matches[next]);
  }, [findText, currentIndex, getView, syncHighlight, scrollToMatch]);

  /** 替换当前匹配 */
  const handleReplaceCurrent = useCallback(() => {
    if (!findText) return;
    const view = getView();
    if (!view) return;
    const matches = collectSearchMatches(view.state.doc, findText);
    if (matches.length === 0) return;
    const idx = Math.min(currentIndex, matches.length - 1);
    const target = matches[idx];
    view.dispatch(view.state.tr.insertText(replaceText, target.from, target.to));
    // 替换后重新计算，停留在同一索引（即下一个匹配）
    const remaining = collectSearchMatches(view.state.doc, findText);
    const nextIdx = remaining.length === 0 ? 0 : Math.min(idx, remaining.length - 1);
    syncHighlight(findText, nextIdx);
    scrollToMatch(remaining[nextIdx]);
  }, [findText, replaceText, currentIndex, getView, syncHighlight, scrollToMatch]);

  /** 全部替换（从后往前避免位置偏移） */
  const handleReplaceAll = useCallback(() => {
    if (!findText) return;
    const view = getView();
    if (!view) return;
    const matches = collectSearchMatches(view.state.doc, findText);
    if (matches.length === 0) return;
    let tr = view.state.tr;
    for (let i = matches.length - 1; i >= 0; i--) {
      tr = tr.insertText(replaceText, matches[i].from, matches[i].to);
    }
    view.dispatch(tr);
    syncHighlight(findText, 0);
  }, [findText, replaceText, getView, syncHighlight]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigate(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className={cn("absolute top-4 right-8 z-50 bg-background border border-border/60 shadow-lg rounded-lg w-[320px] overflow-hidden flex flex-col", className)}>
      <div className="flex items-center p-2 border-b border-border/40 gap-2">
        <NotionButton 
          variant="ghost" 
          size="sm" 
          className="h-6 w-6 p-0" 
          onClick={() => setIsReplaceMode(!isReplaceMode)}
          title={isReplaceMode
            ? t('notes:findReplace.hideReplace', '收起替换')
            : t('notes:findReplace.showReplace', '展开替换')}
        >
          <CaretDown className={cn("h-4 w-4 transition-transform", isReplaceMode && "-rotate-90")} />
        </NotionButton>
        
        <div className="flex-1 relative flex items-center">
          <MagnifyingGlass className="absolute left-2 w-3.5 h-3.5 text-muted-foreground" />
          <Input 
            ref={findInputRef}
            className="h-7 text-xs pl-7 pr-12 bg-transparent border-none focus-visible:ring-1"
            placeholder={t('notes:findReplace.findPlaceholder', '查找…')}
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {findText && (
            <span className="absolute right-2 text-[10px] text-muted-foreground tabular-nums">
              {matchCount > 0 ? `${currentIndex + 1}/${matchCount}` : '0/0'}
            </span>
          )}
        </div>
        
        <div className="flex items-center gap-0.5">
          <NotionButton
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => navigate(-1)}
            disabled={matchCount === 0}
            title={t('notes:findReplace.prev', '上一个 (Shift+Enter)')}
          >
            <CaretUp className="h-4 w-4" />
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => navigate(1)}
            disabled={matchCount === 0}
            title={t('notes:findReplace.next', '下一个 (Enter)')}
          >
            <CaretDown className="h-4 w-4" />
          </NotionButton>
          <div className="w-[1px] h-4 bg-border/60 mx-0.5" />
          <NotionButton variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground" onClick={onClose}>
            <X className="h-4 w-4" />
          </NotionButton>
        </div>
      </div>
      
      {isReplaceMode && (
        <div className="flex items-center p-2 gap-2 bg-muted/10">
          <div className="w-6" /> {/* Spacer to align with input above */}
          <div className="flex-1 relative">
            <Input 
              className="h-7 text-xs pl-2 bg-transparent border-none focus-visible:ring-1"
              placeholder={t('notes:findReplace.replacePlaceholder', '替换为…')}
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div className="flex items-center gap-1">
            <NotionButton
              variant="secondary"
              size="sm"
              className="h-6 text-[10px] px-2"
              disabled={!findText || matchCount === 0}
              onClick={handleReplaceCurrent}
            >
              {t('notes:findReplace.replace', '替换')}
            </NotionButton>
            <NotionButton
              variant="secondary"
              size="sm"
              className="h-6 text-[10px] px-2"
              disabled={!findText || matchCount === 0}
              onClick={handleReplaceAll}
            >
              {t('notes:findReplace.replaceAll', '全部')}
            </NotionButton>
          </div>
        </div>
      )}
    </div>
  );
};
