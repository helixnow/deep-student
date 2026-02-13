import React from 'react';
import { useTranslation } from 'react-i18next';
import { 
  BookOpen, 
  Trash2, 
  MoreVertical, 
  Calendar, 
  FileText,
  RotateCcw,
  Ban,
  Star,
  Clock
} from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { Card, CardContent } from './ui/shad/Card';
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
  AppMenuTrigger,
} from './ui/app-menu';
import { cn } from '../utils/cn';
import { Skeleton } from './ui/shad/Skeleton';

export interface TextbookItem {
  id: string;
  name: string;
  path: string;
  size: number;
  addedAt: string;
  pageCount?: number | null;
  isFavorite?: boolean;
  lastOpenedAt?: string | null;
  lastPage?: number | null;
}

interface TextbookCardProps {
  book: TextbookItem;
  viewMode: 'grid' | 'list';
  coverUrl: string | null;
  statusFilter: 'active' | 'trashed' | 'all';
  onOpen: (book: TextbookItem) => void;
  onDelete: (book: TextbookItem) => void;
  onRecover: (book: TextbookItem) => void;
  onDeletePermanent: (book: TextbookItem) => void;
  onToggleFavorite?: (book: TextbookItem) => void;
}

export const TextbookCard: React.FC<TextbookCardProps> = ({
  book,
  viewMode,
  coverUrl,
  statusFilter,
  onOpen,
  onDelete,
  onRecover,
  onDeletePermanent,
  onToggleFavorite,
}) => {
  const { t } = useTranslation(['common']);

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDate = (isoString: string): string => {
    const date = new Date(isoString);
    return date.toLocaleDateString();
  };

  const isTrashed = statusFilter === 'trashed';

  if (viewMode === 'grid') {
    return (
      <Card 
        className="group relative overflow-hidden border bg-card text-card-foreground shadow-sm transition-all hover:shadow-md hover:-translate-y-1 cursor-pointer"
        onClick={() => !isTrashed && onOpen(book)}
      >
        <div className="aspect-[3/4] w-full overflow-hidden bg-muted relative">
          {coverUrl ? (
            <img 
              src={coverUrl} 
              alt={book.name} 
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" 
            />
          ) : (
            <div className="h-full w-full flex items-center justify-center bg-muted/50">
              <BookOpen className="h-12 w-12 text-muted-foreground/20" />
            </div>
          )}
          
          {/* 收藏标记 */}
          {book.isFavorite && (
            <div className="absolute top-2 right-2 p-1 rounded-full bg-yellow-400/90 shadow-sm">
              <Star className="h-3.5 w-3.5 fill-white text-white" />
            </div>
          )}
          
          {/* 悬停遮罩 - 仅在非回收站模式下显示打开按钮 */}
          {!isTrashed && (
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
              <NotionButton size="sm" variant="default" className="shadow-lg font-medium translate-y-4 group-hover:translate-y-0 transition-transform">
                {t('common:textbook.open')}
              </NotionButton>
            </div>
          )}
        </div>

        <CardContent className="p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <h3 className="font-medium text-sm leading-tight truncate" title={book.name}>
                {book.name}
              </h3>
              <div className="mt-1.5 flex flex-col gap-0.5 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <FileText className="h-3 w-3" />
                  {formatSize(book.size)}
                </span>
                <span className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  {formatDate(book.addedAt)}
                </span>
              </div>
            </div>

            <div onClick={(e) => e.stopPropagation()}>
              <AppMenu>
                <AppMenuTrigger asChild>
                  <NotionButton variant="ghost" iconOnly size="sm" className="h-8 w-8 -mr-2 text-muted-foreground hover:text-foreground">
                    <MoreVertical className="h-4 w-4" />
                  </NotionButton>
                </AppMenuTrigger>
                <AppMenuContent align="end" width={160}>
                  {!isTrashed ? (
                    <>
                      <AppMenuItem icon={<BookOpen className="h-4 w-4" />} onClick={() => onOpen(book)}>
                        {t('common:textbook.open')}
                      </AppMenuItem>
                      {onToggleFavorite && (
                        <AppMenuItem icon={<Star className={cn("h-4 w-4", book.isFavorite && "fill-yellow-400 text-yellow-400")} />} onClick={() => onToggleFavorite(book)}>
                          {book.isFavorite ? t('common:textbook.unfavorite') : t('common:textbook.favorite')}
                        </AppMenuItem>
                      )}
                      <AppMenuSeparator />
                      <AppMenuItem 
                        icon={<Trash2 className="h-4 w-4" />}
                        destructive
                        onClick={() => onDelete(book)}
                      >
                        {t('common:actions.delete')}
                      </AppMenuItem>
                    </>
                  ) : (
                    <>
                      <AppMenuItem icon={<RotateCcw className="h-4 w-4" />} onClick={() => onRecover(book)}>
                        {t('common:textbook.recover')}
                      </AppMenuItem>
                      <AppMenuSeparator />
                      <AppMenuItem 
                        icon={<Ban className="h-4 w-4" />}
                        destructive
                        onClick={() => onDeletePermanent(book)}
                      >
                        {t('common:textbook.delete_permanent')}
                      </AppMenuItem>
                    </>
                  )}
                </AppMenuContent>
              </AppMenu>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // List View
  return (
    <Card 
      className="group flex flex-row items-center p-3 gap-4 overflow-hidden border bg-card text-card-foreground shadow-sm transition-all hover:shadow-md cursor-pointer"
      onClick={() => !isTrashed && onOpen(book)}
    >
      <div className="h-20 w-16 flex-shrink-0 overflow-hidden rounded-md bg-muted relative border">
        {coverUrl ? (
          <img 
            src={coverUrl} 
            alt={book.name} 
            className="h-full w-full object-cover" 
          />
        ) : (
          <div className="h-full w-full flex items-center justify-center bg-muted/50">
            <BookOpen className="h-6 w-6 text-muted-foreground/20" />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <h3 className="font-medium text-base truncate" title={book.name}>
            {book.name}
          </h3>
          {book.isFavorite && (
            <Star className="h-4 w-4 flex-shrink-0 fill-yellow-400 text-yellow-400" />
          )}
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <FileText className="h-3.5 w-3.5" />
            {formatSize(book.size)}
          </span>
          <span className="flex items-center gap-1">
            <Calendar className="h-3.5 w-3.5" />
            {formatDate(book.addedAt)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        {!isTrashed ? (
          <>
            <NotionButton variant="default" size="sm" onClick={() => onOpen(book)} className="hidden sm:flex">
              {t('common:textbook.open')}
            </NotionButton>
            <AppMenu>
              <AppMenuTrigger asChild>
                <NotionButton variant="ghost" iconOnly size="sm" className="h-8 w-8 text-muted-foreground hover:text-foreground">
                  <MoreVertical className="h-4 w-4" />
                </NotionButton>
              </AppMenuTrigger>
              <AppMenuContent align="end" width={160}>
                <AppMenuItem icon={<BookOpen className="h-4 w-4" />} onClick={() => onOpen(book)} className="sm:hidden">
                  {t('common:textbook.open')}
                </AppMenuItem>
                {onToggleFavorite && (
                  <AppMenuItem icon={<Star className={cn("h-4 w-4", book.isFavorite && "fill-yellow-400 text-yellow-400")} />} onClick={() => onToggleFavorite(book)}>
                    {book.isFavorite ? t('common:textbook.unfavorite') : t('common:textbook.favorite')}
                  </AppMenuItem>
                )}
                <AppMenuSeparator />
                <AppMenuItem 
                  icon={<Trash2 className="h-4 w-4" />}
                  destructive
                  onClick={() => onDelete(book)}
                >
                  {t('common:actions.delete')}
                </AppMenuItem>
              </AppMenuContent>
            </AppMenu>
          </>
        ) : (
          <>
            <NotionButton size="sm" variant="ghost" onClick={() => onRecover(book)}>
              {t('common:textbook.recover')}
            </NotionButton>
            <NotionButton size="sm" variant="ghost" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => onDeletePermanent(book)}>
              <Trash2 className="h-4 w-4" />
            </NotionButton>
          </>
        )}
      </div>
    </Card>
  );
};


