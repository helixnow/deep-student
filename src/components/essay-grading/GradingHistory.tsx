import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '../ui/shad/Input';
import { Badge } from '../ui/shad/Badge';
import { CustomScrollArea } from '../custom-scroll-area';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { History, Search, Star, Trash2, Clock, Layers } from 'lucide-react';
import type { EssaySessionItem } from '@/dstu/adapters/essayDstuAdapter';

interface GradingHistoryProps {
  history: EssaySessionItem[];
  historyTotal: number;
  historySearch: string;
  setHistorySearch: (search: string) => void;
  onLoadHistory: (reset: boolean) => void;
  onRestoreHistory: (item: EssaySessionItem) => void;
  onDeleteHistory: (id: string) => void;
  onToggleFavorite: (id: string) => void;
}

export const GradingHistory: React.FC<GradingHistoryProps> = ({
  history,
  historyTotal,
  historySearch,
  setHistorySearch,
  onLoadHistory,
  onRestoreHistory,
  onDeleteHistory,
  onToggleFavorite,
}) => {
  const { t } = useTranslation(['essay_grading', 'common']);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);

  // 过滤后的历史记录
  const filteredHistory = useMemo(() => {
    if (!showFavoritesOnly) return history;
    return history.filter(item => item.is_favorite);
  }, [history, showFavoritesOnly]);

  // 收藏数量
  const favoriteCount = useMemo(() => history.filter(item => item.is_favorite).length, [history]);

  // 获取作文类型显示文本
  const getEssayTypeLabel = (type: string) => {
    switch (type) {
      case 'narrative': return t('essay_grading:essay_type.narrative');
      case 'argumentative': return t('essay_grading:essay_type.argumentative');
      case 'expository': return t('essay_grading:essay_type.expository');
      default: return t('essay_grading:essay_type.other');
    }
  };

  return (
    <div className="h-full flex flex-col bg-background">
      {/* History Toolbar */}
      <div className="flex items-center justify-between px-4 h-12 border-b bg-background/50 backdrop-blur z-10 shrink-0">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <History className="w-4 h-4" />
          {t('essay_grading:tabs.history')}
          <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-[10px] font-normal">
            {historyTotal}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          {/* 收藏筛选 */}
          <CommonTooltip
            content={showFavoritesOnly ? t('essay_grading:history.show_all') : t('essay_grading:history.show_favorites_only')}
          >
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
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              placeholder={t('essay_grading:history.search_placeholder')}
              className="pl-8 h-8 text-xs bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background focus:border-primary/50 transition-all shadow-none rounded-md"
            />
          </div>
        </div>
      </div>

      {/* History List */}
      <div className="flex-1 overflow-hidden relative">
        <CustomScrollArea className="h-full" viewportClassName="h-full" trackOffsetTop={0} trackOffsetBottom={0} trackOffsetRight={0}>
          <div className="flex flex-col">
            {filteredHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-32 text-center">
                <div className="w-16 h-16 rounded-full bg-muted/30 flex items-center justify-center mb-4">
                  {showFavoritesOnly ? (
                    <Star className="w-8 h-8 text-muted-foreground/40" />
                  ) : (
                    <History className="w-8 h-8 text-muted-foreground/40" />
                  )}
                </div>
                <h3 className="text-base font-medium text-foreground mb-1">
                  {showFavoritesOnly ? t('essay_grading:history.no_favorites') : t('essay_grading:history.empty')}
                </h3>
                <p className="text-xs text-muted-foreground max-w-xs">
                  {showFavoritesOnly ? t('essay_grading:history.no_favorites_hint') : t('essay_grading:history.empty_hint')}
                </p>
              </div>
            ) : (
              <>
                {filteredHistory.map((item) => (
                  <div
                    key={item.id}
                    className="group relative border-b hover:bg-muted/30 transition-colors cursor-pointer"
                    onClick={() => onRestoreHistory(item)}
                  >
                    <div className="px-6 py-4">
                      {/* Header Line */}
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <span className="font-medium text-sm text-foreground truncate max-w-[200px]">
                            {item.title}
                          </span>
                          <Badge variant="outline" className="h-5 px-2 font-mono text-[10px] text-muted-foreground border-border/50 bg-background/50">
                            {getEssayTypeLabel(item.essay_type)}
                          </Badge>
                          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                            <Layers className="w-3 h-3" />
                            {t('essay_grading:history.rounds_count', { count: item.total_rounds })}
                          </div>
                        </div>

                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                          <CommonTooltip
                            content={item.is_favorite ? t('essay_grading:history.unfavorite') : t('essay_grading:history.favorite')}
                          >
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
                          <CommonTooltip content={t('essay_grading:history.delete')}>
                            <NotionButton
                              variant="ghost"
                              size="icon"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDeleteHistory(item.id);
                              }}
                              className="h-7 w-7 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </NotionButton>
                          </CommonTooltip>
                        </div>

                        {/* Favorite Badge (Always visible if favorited) */}
                        {item.is_favorite && (
                          <div className="absolute top-4 right-4 group-hover:opacity-0 transition-opacity duration-200">
                            <Star className="w-3.5 h-3.5 text-yellow-500 fill-current" />
                          </div>
                        )}
                      </div>

                      {/* Time and Preview */}
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70 mb-2">
                        <Clock className="w-3 h-3" />
                        {new Date(item.updated_at).toLocaleString()}
                      </div>

                      {/* Preview */}
                      {item.latest_input_preview && (
                        <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed font-mono">
                          {item.latest_input_preview}
                        </p>
                      )}
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
                      {t('essay_grading:history.load_more')}
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
