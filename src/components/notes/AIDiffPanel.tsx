import React, { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, Bot } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '../custom-scroll-area';
import type { AIEditState, CanvasEditOperation, DiffLine } from './hooks/useAIEditState';

interface AIDiffPanelProps {
  state: AIEditState;
  onAccept: () => void;
  onReject: () => void;
  className?: string;
}

function DiffLineView({ line }: { line: DiffLine }) {
  const bgClass = {
    unchanged: '',
    added: 'bg-green-100 dark:bg-green-900/30',
    removed: 'bg-red-100 dark:bg-red-900/30',
  }[line.type];
  
  const prefixChar = {
    unchanged: ' ',
    added: '+',
    removed: '-',
  }[line.type];
  
  const prefixClass = {
    unchanged: 'text-muted-foreground',
    added: 'text-green-600 dark:text-green-400',
    removed: 'text-red-600 dark:text-red-400',
  }[line.type];

  return (
    <div className={cn('flex font-mono text-xs leading-5', bgClass)}>
      <span className={cn('w-8 text-right pr-2 select-none text-muted-foreground/60')}>
        {line.lineNumber.old || line.lineNumber.new || ''}
      </span>
      <span className={cn('w-4 text-center select-none', prefixClass)}>
        {prefixChar}
      </span>
      <span className="flex-1 whitespace-pre-wrap break-all pr-2">
        {line.content || '\u00A0'}
      </span>
    </div>
  );
}

export function AIDiffPanel({ state, onAccept, onReject, className }: AIDiffPanelProps) {
  const { t } = useTranslation('notes');
  const { request, diffLines } = state;

  const operationLabels: Record<CanvasEditOperation, string> = {
    append: t('aiDiff.operation_append'),
    replace: t('aiDiff.operation_replace'),
    set: t('aiDiff.operation_set'),
  };
  
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onAccept();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onReject();
    }
  }, [onAccept, onReject]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!request) return null;

  const hasChanges = diffLines.some(line => line.type !== 'unchanged');
  const addedCount = diffLines.filter(line => line.type === 'added').length;
  const removedCount = diffLines.filter(line => line.type === 'removed').length;

  return (
    <div className={cn(
      'absolute inset-0 z-40 flex flex-col bg-background/95 backdrop-blur-sm',
      'animate-in fade-in slide-in-from-top-2 duration-200',
      className
    )}>
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/50">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10">
            <Bot className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-medium">{t('aiDiff.title')}</h3>
            <p className="text-xs text-muted-foreground">
              {operationLabels[request.operation]}
              {hasChanges && (
                <span className="ml-2">
                  <span className="text-green-600 dark:text-green-400">+{addedCount}</span>
                  {' / '}
                  <span className="text-red-600 dark:text-red-400">-{removedCount}</span>
                </span>
              )}
            </p>
          </div>
        </div>
        <NotionButton
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onReject}
        >
          <X className="h-4 w-4" />
        </NotionButton>
      </div>

      <CustomScrollArea className="flex-1" viewportClassName="p-4">
        <div className="rounded-lg border bg-card overflow-hidden">
          {diffLines.length === 0 ? (
            <div className="p-4 text-center text-muted-foreground text-sm">
              {t('aiDiff.no_changes')}
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {diffLines.map((line, index) => (
                <DiffLineView key={index} line={line} />
              ))}
            </div>
          )}
        </div>
      </CustomScrollArea>

      <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/30">
        <div className="text-xs text-muted-foreground">
          <kbd className="px-1.5 py-0.5 rounded bg-muted border text-[10px]">⌘↵</kbd>
          {` ${t('aiDiff.accept')} · `}
          <kbd className="px-1.5 py-0.5 rounded bg-muted border text-[10px]">Esc</kbd>
          {` ${t('aiDiff.reject')}`}
        </div>
        <div className="flex items-center gap-2">
          <NotionButton
            variant="outline"
            size="sm"
            onClick={onReject}
            className="h-8"
          >
            <X className="h-3.5 w-3.5 mr-1.5" />
            {t('aiDiff.reject')}
          </NotionButton>
          <NotionButton
            size="sm"
            onClick={onAccept}
            className="h-8"
          >
            <Check className="h-3.5 w-3.5 mr-1.5" />
            {t('aiDiff.accept')}
          </NotionButton>
        </div>
      </div>
    </div>
  );
}

export default AIDiffPanel;
