/**
 * 练习模式选择器组件
 * 
 * Notion 风格的模式选择卡片网格
 */

import React, { useCallback } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/shad/Card';
import {
  ListNumbers,
  Shuffle,
  ArrowCounterClockwise,
  Tag,
  Timer,
  FileText,
  CalendarBlank,
  ClipboardText,
} from '@phosphor-icons/react';
import { PracticeMode } from '@/stores/questionBankStore';
import { useTranslation } from 'react-i18next';

interface PracticeModeSelectorProps {
  currentMode: PracticeMode;
  onModeChange: (mode: PracticeMode) => void;
  className?: string;
}

interface ModeConfig {
  key: PracticeMode;
  icon: React.ElementType;
  label: string;
  desc: string;
  color: string;
  bgColor: string;
}

export const PracticeModeSelector: React.FC<PracticeModeSelectorProps> = ({
  currentMode,
  onModeChange,
  className,
}) => {
  const { t } = useTranslation('practice');
  
  const modes: ModeConfig[] = [
    {
      key: 'sequential',
      icon: ListNumbers,
      label: t('modes.sequential.label'),
      desc: t('modes.sequential.desc'),
      color: 'text-muted-foreground',
      bgColor: 'bg-muted',
    },
    {
      key: 'random',
      icon: Shuffle,
      label: t('modes.random.label'),
      desc: t('modes.random.desc'),
      color: 'text-primary',
      bgColor: 'bg-primary/10',
    },
    {
      key: 'review_first',
      icon: ArrowCounterClockwise,
      label: t('modes.reviewFirst.label'),
      desc: t('modes.reviewFirst.desc'),
      color: 'text-warning',
      bgColor: 'bg-warning/10',
    },
    {
      key: 'review_only',
      icon: ArrowCounterClockwise,
      label: t('modes.reviewOnly.label'),
      desc: t('modes.reviewOnly.desc'),
      color: 'text-warning',
      bgColor: 'bg-warning/10',
    },
    {
      key: 'by_tag',
      icon: Tag,
      label: t('modes.byTag.label'),
      desc: t('modes.byTag.desc'),
      color: 'text-primary',
      bgColor: 'bg-primary/10',
    },
    {
      key: 'timed',
      icon: Timer,
      label: t('modes.timed.label'),
      desc: t('modes.timed.desc'),
      color: 'text-destructive',
      bgColor: 'bg-destructive/10',
    },
    {
      key: 'mock_exam',
      icon: FileText,
      label: t('modes.mockExam.label'),
      desc: t('modes.mockExam.desc'),
      color: 'text-info',
      bgColor: 'bg-info/10',
    },
    {
      key: 'daily',
      icon: CalendarBlank,
      label: t('modes.daily.label'),
      desc: t('modes.daily.desc'),
      color: 'text-success',
      bgColor: 'bg-success/10',
    },
    {
      key: 'paper',
      icon: ClipboardText,
      label: t('modes.paper.label'),
      desc: t('modes.paper.desc'),
      color: 'text-warning',
      bgColor: 'bg-warning/10',
    },
  ];
  
  const handleSelect = useCallback((mode: PracticeMode) => {
    onModeChange(mode);
  }, [onModeChange]);
  
  return (
    <div className={cn('grid grid-cols-2 sm:grid-cols-4 gap-3', className)}>
      {modes.map(({ key, icon: Icon, label, desc, color, bgColor }) => (
        <NotionButton
          key={key}
          variant="ghost" size="sm"
          onClick={() => handleSelect(key)}
          aria-pressed={currentMode === key}
          className={cn(
            '!relative !p-4 !h-auto !rounded-xl border !text-left !justify-start !items-start flex-col',
            'ui-press ui-state-colors hover:shadow-md',
            currentMode === key
              ? 'border-primary/50 bg-primary/5 shadow-sm'
              : 'border-border hover:border-border/80 bg-card'
          )}
        >
          {/* 选中指示器 */}
          {currentMode === key && (
            <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-primary" />
          )}
          
          {/* 图标 */}
          <div className={cn(
            'w-10 h-10 rounded-lg flex items-center justify-center mb-3 transition-colors',
            currentMode === key ? 'bg-primary/15' : bgColor
          )}>
            <Icon className={cn(
              'w-5 h-5 transition-colors',
              currentMode === key ? 'text-primary' : color
            )} />
          </div>
          
          {/* 标签 */}
          <div className={cn(
            'font-medium text-sm mb-1 transition-colors',
            currentMode === key ? 'text-primary' : 'text-foreground'
          )}>
            {label}
          </div>
          
          {/* 描述 */}
          <div className="text-xs text-muted-foreground line-clamp-2">
            {desc}
          </div>
        </NotionButton>
      ))}
    </div>
  );
};

export default PracticeModeSelector;
