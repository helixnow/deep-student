/**
 * 内容搜索结果列表组件
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, MessageSquare, Loader2, User, Bot, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ContentSearchResult } from '../../hooks/useContentSearch';

const INITIAL_ITEMS_PER_SESSION = 3;

interface SearchResultListProps {
  results: ContentSearchResult[];
  loading: boolean;
  query: string;
  onSelectResult: (sessionId: string) => void;
}

export const SearchResultList: React.FC<SearchResultListProps> = ({
  results,
  loading,
  query,
  onSelectResult,
}) => {
  const { t } = useTranslation(['chatV2']);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());

  const toggleExpanded = useCallback((sessionId: string) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        <span className="text-sm">{t('search.searching')}</span>
      </div>
    );
  }

  if (query.trim().length >= 2 && results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Search className="w-8 h-8 mb-2 opacity-40" />
        <span className="text-sm">{t('search.noContentResults')}</span>
      </div>
    );
  }

  if (results.length === 0) {
    return null;
  }

  const grouped = new Map<string, { title: string | null; items: ContentSearchResult[] }>();
  for (const r of results) {
    if (!grouped.has(r.sessionId)) {
      grouped.set(r.sessionId, { title: r.sessionTitle, items: [] });
    }
    grouped.get(r.sessionId)!.items.push(r);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
        <Search className="w-3.5 h-3.5" />
        <span>
          {t('search.contentResultCount', { count: results.length })}
        </span>
      </div>
      {Array.from(grouped.entries()).map(([sessionId, { title, items }]) => {
        const isExpanded = expandedSessions.has(sessionId);
        const displayItems = isExpanded ? items : items.slice(0, INITIAL_ITEMS_PER_SESSION);
        const hasMore = items.length > INITIAL_ITEMS_PER_SESSION;

        return (
          <div key={sessionId} className="space-y-1">
            <button
              onClick={() => onSelectResult(sessionId)}
              className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md hover:bg-muted/50 transition-colors group"
            >
              <MessageSquare className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
              <span className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
                {title || t('page.untitled')}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground/60 shrink-0">
                {items.length}
              </span>
            </button>
            <div className="ml-6 space-y-0.5">
              {displayItems.map((item) => (
                <button
                  key={item.blockId}
                  onClick={() => onSelectResult(item.sessionId)}
                  className="w-full text-left px-2 py-1 rounded hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-start gap-1.5">
                    {item.role === 'user' ? (
                      <User className="w-3 h-3 text-muted-foreground/40 mt-0.5 shrink-0" />
                    ) : (
                      <Bot className="w-3 h-3 text-primary/40 mt-0.5 shrink-0" />
                    )}
                    <p
                      className="text-xs text-muted-foreground line-clamp-2 leading-relaxed [&_mark]:bg-yellow-200/60 [&_mark]:dark:bg-yellow-500/30 [&_mark]:rounded-sm [&_mark]:px-0.5"
                      dangerouslySetInnerHTML={{ __html: item.snippet }}
                    />
                  </div>
                </button>
              ))}
              {hasMore && (
                <button
                  onClick={(e) => { e.stopPropagation(); toggleExpanded(sessionId); }}
                  className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                >
                  <ChevronDown className={cn('w-3 h-3 transition-transform', isExpanded && 'rotate-180')} />
                  {isExpanded
                    ? t('tags.showLess')
                    : t('tags.showMore', { count: items.length - INITIAL_ITEMS_PER_SESSION })}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default SearchResultList;
