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
  ListOrdered,
  Shuffle,
  RotateCcw,
  Tag,
  Timer,
  FileText,
  CalendarDays,
  ClipboardList,
} from 'lucide-react';
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
      icon: ListOrdered,
      label: t('modes.sequential.label'),
      desc: t('modes.sequential.desc'),
      color: 'text-slate-600',
      bgColor: 'bg-slate-500/10',
    },
    {
      key: 'random',
      icon: Shuffle,
      label: t('modes.random.label'),
      desc: t('modes.random.desc'),
      color: 'text-purple-600',
      bgColor: 'bg-purple-500/10',
    },
    {
      key: 'review_first',
      icon: RotateCcw,
      label: t('modes.reviewFirst.label'),
      desc: t('modes.reviewFirst.desc'),
      color: 'text-amber-600',
      bgColor: 'bg-amber-500/10',
    },
    {
      key: 'by_tag',
      icon: Tag,
      label: t('modes.byTag.label'),
      desc: t('modes.byTag.desc'),
      color: 'text-sky-600',
      bgColor: 'bg-sky-500/10',
    },
    {
      key: 'timed',
      icon: Timer,
      label: t('modes.timed.label'),
      desc: t('modes.timed.desc'),
      color: 'text-rose-600',
      bgColor: 'bg-rose-500/10',
    },
    {
      key: 'mock_exam',
      icon: FileText,
      label: t('modes.mockExam.label'),
      desc: t('modes.mockExam.desc'),
      color: 'text-indigo-600',
      bgColor: 'bg-indigo-500/10',
    },
    {
      key: 'daily',
      icon: CalendarDays,
      label: t('modes.daily.label'),
      desc: t('modes.daily.desc'),
      color: 'text-emerald-600',
      bgColor: 'bg-emerald-500/10',
    },
    {
      key: 'paper',
      icon: ClipboardList,
      label: t('modes.paper.label'),
      desc: t('modes.paper.desc'),
      color: 'text-orange-600',
      bgColor: 'bg-orange-500/10',
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
          className={cn(
            '!p-4 !h-auto !rounded-xl border !text-left !justify-start !items-start flex-col',
            'hover:shadow-md hover:scale-[1.02]',
            currentMode === key
              ? 'border-sky-500 bg-sky-500/5 shadow-sm'
              : 'border-border hover:border-border/80 bg-card'
          )}
        >
          {/* 选中指示器 */}
          {currentMode === key && (
            <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-sky-500" />
          )}
          
          {/* 图标 */}
          <div className={cn(
            'w-10 h-10 rounded-lg flex items-center justify-center mb-3 transition-colors',
            currentMode === key ? 'bg-sky-500/20' : bgColor
          )}>
            <Icon className={cn(
              'w-5 h-5 transition-colors',
              currentMode === key ? 'text-sky-600' : color
            )} />
          </div>
          
          {/* 标签 */}
          <div className={cn(
            'font-medium text-sm mb-1 transition-colors',
            currentMode === key ? 'text-sky-700 dark:text-sky-400' : 'text-foreground'
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
