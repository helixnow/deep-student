import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '../ui/shad/Input';
import { Badge } from '../ui/shad/Badge';
import { CustomScrollArea } from '../custom-scroll-area';
import { CommonTooltip } from '../shared/CommonTooltip';
import { ClockCounterClockwise, MagnifyingGlass, Star, Trash, ArrowRight, Clock } from '@phosphor-icons/react';
import { type TranslationHistoryItem } from '../../utils/tauriApi';

interface TranslationHistoryProps {
  history: TranslationHistoryItem[];
  historyTotal: number;
  historySearch: string;
  setHistorySearch: (search: string) => void;
  onLoadHistory: (reset: boolean) => void;
  onRestoreHistory: (item: TranslationHistoryItem) => void;
  onDeleteHistory: (id: string) => void;
  onToggleFavorite: (id: string) => void;
}

export const TranslationHistory: React.FC<TranslationHistoryProps> = ({
  history,
  historyTotal,
  historySearch,
  setHistorySearch,
  onLoadHistory,
  onRestoreHistory,
  onDeleteHistory,
  onToggleFavorite,
}) => {
  const { t } = useTranslation(['translation', 'common']);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);

  // 过滤后的历史记录
  const filteredHistory = useMemo(() => {
    if (!showFavoritesOnly) return history;
    return history.filter(item => item.is_favorite);
  }, [history, showFavoritesOnly]);

  // 收藏数量
  const favoriteCount = useMemo(() => history.filter(item => item.is_favorite).length, [history]);

  return (
    <div className="h-full flex flex-col bg-background">
      {/* ClockCounterClockwise Toolbar */}
      <div className="flex items-center justify-between px-4 h-12 border-b bg-background/50 backdrop-blur z-10 shrink-0">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <ClockCounterClockwise size={16} />
          {t('translation:tabs.history')}
          <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-[10px] font-normal">
            {historyTotal}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          {/* 收藏筛选 */}
          <CommonTooltip content={showFavoritesOnly ? t('translation:history.show_all') : t('translation:history.show_favorites_only')}>
            <NotionButton
              variant={showFavoritesOnly ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
              className={`h-8 px-2 ${showFavoritesOnly ? 'bg-yellow-500/20 text-yellow-600 hover:bg-yellow-500/30' : ''}`}
            >
              <Star className={`w-3.5 h-3.5 mr-1 ${showFavoritesOnly ? 'fill-current' : ''}`} />
              <span className="text-xs">{favoriteCount}</span>
            </NotionButton>
          </CommonTooltip>

          {/* 搜索框 */}
          <div className="relative w-56">
            <MagnifyingGlass size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              placeholder={t('translation:history.search_placeholder')}
              className="pl-8 h-8 text-xs bg-muted/30 border-transparent hover:bg-[var(--interactive-hover)] focus:bg-background focus:border-primary/50 transition-all shadow-none rounded-md"
/>
          </div>
        </div>
      </div>

      {/* ClockCounterClockwise List */}
      <div className="flex-1 overflow-hidden relative">
        <CustomScrollArea className="h-full" viewportClassName="h-full" trackOffsetTop={0} trackOffsetBottom={0} trackOffsetRight={0}>
          <div className="flex flex-col">
            {filteredHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-32 text-center">
                <div className="w-16 h-16 rounded-full bg-muted/30 flex items-center justify-center mb-4">
                  {showFavoritesOnly ? (
                    <Star size={32} className="text-muted-foreground/40" />
                  ) : (
                    <ClockCounterClockwise size={32} className="text-muted-foreground/40" />
                  )}
                </div>
                <h3 className="text-base font-medium text-foreground mb-1">
                  {showFavoritesOnly ? t('translation:history.no_favorites') : t('translation:history.empty')}
                </h3>
                <p className="text-xs text-muted-foreground max-w-xs">
                  {showFavoritesOnly ? t('translation:history.no_favorites_hint') : t('translation:history.empty_hint')}
                </p>
              </div>
            ) : (
              <>
                {filteredHistory.map((item) => (
                  <div
                    key={item.id}
                    className="group relative border-b hover:bg-[var(--interactive-hover)] transition-colors cursor-pointer"
                    onClick={() => onRestoreHistory(item)}
                  >
                    <div className="px-6 py-4">
                      {/* Header Line */}
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <Badge variant="outline" className="h-5 px-2 font-mono text-[10px] text-muted-foreground border-border/50 bg-background/50">
                            {item.src_lang} <ArrowRight size={10} className="mx-1" /> {item.tgt_lang}
                          </Badge>
                          <div className="flex items-center text-[10px] text-muted-foreground/70">
                            <Clock size={12} className="mr-1" />
                            {new Date(item.created_at).toLocaleString()}
                          </div>
                          {/* 评分显示 */}
                          {item.quality_rating && (
                            <div className="flex items-center gap-0.5">
                              {[1, 2, 3, 4, 5].map((i) => (
                                <Star
                                  key={i}
                                  className={`w-3 h-3 ${i <= (item.quality_rating || 0) ? 'text-yellow-500 fill-current' : 'text-muted-foreground/30'}`}
/>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                          <CommonTooltip content={item.is_favorite ? t('translation:history.unfavorite') : t('translation:history.favorite')}>
                            <NotionButton
                              variant="ghost"
                              size="icon"
                              onClick={(e) => {
                                e.stopPropagation();
                                onToggleFavorite(item.id);
                              }}
                              className={`h-7 w-7 rounded-md ${item.is_favorite ? 'text-yellow-500 hover:text-yellow-600' : 'text-muted-foreground hover:text-foreground'}`}
                            >
                              <Star className={`w-3.5 h-3.5 ${item.is_favorite ? 'fill-current' : ''}`} />
                            </NotionButton>
                          </CommonTooltip>
                          <CommonTooltip content={t('translation:history.delete')}>
                            <NotionButton
                              variant="ghost"
                              size="icon"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDeleteHistory(item.id);
                              }}
 className="w-7 h-7 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            >
                              <Trash size={14} />
                            </NotionButton>
                          </CommonTooltip>
                        </div>

                        {/* Favorite Badge (Always visible if favorited) */}
                        {item.is_favorite && (
                          <div className="absolute top-4 right-4 group-hover:opacity-0 transition-opacity duration-200">
                            <Star size={14} className="text-yellow-500 fill-current" />
                          </div>
                        )}
                      </div>

                      {/* Content Grid */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="relative">
                          <p className="text-sm text-foreground/80 line-clamp-2 leading-relaxed font-mono">
                            {item.source_text}
                          </p>
                        </div>
                        <div className="relative md:pl-6 md:border-l border-border/40">
                          <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed font-mono">
                            {item.translated_text}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                {!showFavoritesOnly && history.length < historyTotal && (
                  <div className="py-6 flex justify-center border-t border-dashed">
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-primary"
                      onClick={() => onLoadHistory(false)}
                    >
                      {t('translation:history.load_more')}
                    </NotionButton>
                  </div>
                )}
              </>
            )}
          </div>
        </CustomScrollArea>
      </div>
    </div>
  );
};
