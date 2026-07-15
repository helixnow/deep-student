/**
 * 知识点导航视图
 * 
 * 将题目标签聚合为可导航的目录结构：
 * - 按标签分组显示题目数量
 * - 支持展开/收起查看标签下的题目
 * - 支持按标签筛选进入练习模式
 * - 显示每个标签的掌握进度
 * 
 * 知识点树导航设计
 */

import React, { useState, useMemo, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from './custom-scroll-area';
import { Badge } from '@/components/ui/shad/Badge';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import {
  Tag,
  CaretRight,
  CaretDown,
  MagnifyingGlass,
  Play,
  Check,
  X,
  Hash,
  Stack,
  Sparkle,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { Question, QuestionStatus, Difficulty } from '@/api/questionBankApi';

export interface TagNavigationViewProps {
  /** 所有题目 */
  questions: Question[];
  /** 点击题目进入练习 */
  onQuestionClick?: (index: number) => void;
  /** 按标签开始练习 */
  onStartPracticeByTag?: (tag: string) => void;
  className?: string;
}

interface TagGroup {
  tag: string;
  questions: Question[];
  totalCount: number;
  masteredCount: number;
  reviewCount: number;
  newCount: number;
  progressPercent: number;
}

const STATUS_CONFIG: Record<QuestionStatus, { color: string; bg: string }> = {
  new: { color: 'text-muted-foreground', bg: 'bg-muted-foreground' },
  in_progress: { color: 'text-info', bg: 'bg-info' },
  mastered: { color: 'text-success', bg: 'bg-success' },
  review: { color: 'text-warning', bg: 'bg-warning' },
};

const DIFFICULTY_CONFIG: Record<Difficulty, { color: string }> = {
  easy: { color: 'text-success' },
  medium: { color: 'text-warning' },
  hard: { color: 'text-destructive/80' },
  very_hard: { color: 'text-destructive' },
};

/**
 * 标签统计摘要
 */
const TagStatsSummary: React.FC<{
  tagGroups: TagGroup[];
  questions: Question[];
}> = ({ tagGroups, questions }) => {
  const { t } = useTranslation('practice');
  const totalTags = tagGroups.filter((group) => group.tag !== '__untagged__').length;
  const untaggedCount = tagGroups.find((group) => group.tag === '__untagged__')?.totalCount || 0;
  const taggedQuestions = questions.length - untaggedCount;
  const avgQuestionsPerTag = totalTags > 0 ? Math.round(taggedQuestions / totalTags) : 0;
  const totalMastered = questions.filter((question) => question.status === 'mastered').length;
  const overallProgress = questions.length > 0 ? (totalMastered / questions.length) * 100 : 0;

  return (
    <div className="flex items-center justify-between gap-6 px-1">
      <div className="flex items-center gap-6">
        {/* 知识点数量 */}
        <div className="flex items-center gap-2">
          <div className="rounded-md bg-primary/10 p-1.5">
            <Stack size={16} className="text-primary" />
          </div>
          <div className="text-sm">
            <span className="font-semibold">{totalTags}</span>
            <span className="text-muted-foreground ml-1">{t('tagNav.knowledgePoints')}</span>
          </div>
        </div>
        
        {/* 题目数 */}
        <div className="text-sm">
          <span className="font-medium">{questions.length}</span>
          <span className="text-muted-foreground ml-1">{t('tagNav.totalQuestions')}</span>
        </div>
        
        {/* 均题数 */}
        <div className="text-sm text-muted-foreground hidden sm:block">
          {t('tagNav.avgPerPoint', { count: avgQuestionsPerTag })}
        </div>
        
        {/* 掌握率 */}
        <div className="text-sm">
          <span className="font-medium text-success">{Math.round(overallProgress)}%</span>
          <span className="text-muted-foreground ml-1">{t('tagNav.masteryRate')}</span>
        </div>
      </div>
      
      {/* 未分类提示 */}
      {untaggedCount > 0 && (
        <div className="text-xs text-warning">
          {t('tagNav.untagged', { count: untaggedCount })}
        </div>
      )}
    </div>
  );
};

/**
 * 标签组卡片
 */
const TagGroupCard: React.FC<{
  group: TagGroup;
  isExpanded: boolean;
  onToggle: () => void;
  onStartPractice?: () => void;
  onQuestionClick?: (questionId: string) => void;
  originalIndexMap: Map<string, number>;
}> = ({ group, isExpanded, onToggle, onStartPractice, onQuestionClick, originalIndexMap }) => {
  const { t } = useTranslation('practice');
  // 获取进度颜色
  const getProgressColor = (percent: number) => {
    if (percent >= 80) return 'bg-success';
    if (percent >= 50) return 'bg-info';
    if (percent >= 20) return 'bg-warning';
    return 'bg-muted-foreground';
  };

  return (
    <div className="group">
      {/* 标签头部 - 紧凑行 */}
      <NotionButton variant="ghost" size="sm" onClick={onToggle} aria-expanded={isExpanded} className="!h-auto !w-full !justify-start !rounded-md !px-2 !py-2 !text-left hover:bg-accent">
        {/* 展开/收起图标 */}
        <div className="flex-shrink-0 text-muted-foreground/60">
          {isExpanded ? (
            <CaretDown size={14} />
          ) : (
            <CaretRight size={14} />
          )}
        </div>

        {/* 标签图标和名称 */}
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <Hash size={14} className="flex-shrink-0 text-primary" />
          <span className="text-sm font-medium truncate">{group.tag === '__untagged__' ? t('tagNav.untaggedLabel') : group.tag}</span>
          <span className="text-xs text-muted-foreground ml-1">{group.totalCount}</span>
        </div>

        {/* 进度指示 - 更紧凑 */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* 状态分布 - 简化 */}
          <div className="hidden sm:flex items-center gap-1 text-[11px]">
            {group.masteredCount > 0 && (
              <span className="text-success">
                <Check size={12} className="inline" />{group.masteredCount}
              </span>
            )}
            {group.reviewCount > 0 && (
              <span className="ml-1 text-warning">
                <X size={12} className="inline" />{group.reviewCount}
              </span>
            )}
          </div>

          {/* 进度条 - 更细 */}
          <div className="w-12 h-1.5 rounded-full bg-muted/40 overflow-hidden">
            <div 
              className={cn('h-full transition-all', getProgressColor(group.progressPercent))}
              style={{ width: `${group.progressPercent}%` }}
/>
          </div>
          <span className="text-[11px] text-muted-foreground w-7 text-right">
            {Math.round(group.progressPercent)}%
          </span>
        </div>
      </NotionButton>

      {/* 展开内容 */}
      {isExpanded && (
        <div className="ml-5 mt-1 mb-2 pl-3 border-l-2 border-border/40">
          {/* 操作按钮 - 内联式 */}
          <div className="flex items-center gap-2 py-1.5 mb-1">
            {onStartPractice && (
              <NotionButton variant="ghost" size="sm" onClick={(event) => { event.stopPropagation(); onStartPractice(); }} className="!h-auto !px-2 !py-1 text-xs text-primary hover:bg-primary/10">
                <Play size={12} />
                {t('tagNav.practice')}
              </NotionButton>
            )}
            <span className="text-[11px] text-muted-foreground">
              {t('tagNav.toMaster', { count: group.totalCount - group.masteredCount })}
            </span>
          </div>

          {/* 题目列表 - 超紧凑 */}
          <div className="max-h-48 overflow-y-auto space-y-0">
            {group.questions.map((q) => {
              const status = q.status || 'new';
              const statusConfig = STATUS_CONFIG[status];
              const originalIndex = originalIndexMap.get(q.id) || 0;

              return (
                <NotionButton
                  key={q.id}
                  variant="ghost" size="sm"
                  onClick={() => onQuestionClick?.(q.id)}
                  disabled={!onQuestionClick}
                  className="!h-auto !w-full !justify-start !rounded-sm !px-2 !py-1.5 !text-left hover:bg-accent"
                >
                  {/* 状态指示器 */}
                  <div className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', statusConfig.bg)} />
                  
                  {/* 题号 */}
                  <span className="text-[11px] text-muted-foreground w-6 flex-shrink-0">
                    {q.questionLabel || `${originalIndex + 1}`}
                  </span>

                  {/* 题目内容 */}
                  <span className="flex-1 text-xs truncate text-foreground/80">
                    {q.content || q.ocrText || t('tagNav.noContent')}
                  </span>

                  {/* 难度 */}
                  {q.difficulty && (
                    <span className={cn('text-[10px] flex-shrink-0', DIFFICULTY_CONFIG[q.difficulty].color)}>
                      {t(`tagNav.difficultyShort.${q.difficulty}`)}
                    </span>
                  )}
                </NotionButton>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * 空状态
 */
const EmptyState: React.FC = () => {
  const { t } = useTranslation('practice');
  return (
    <div className="flex h-full flex-col items-center justify-center py-12">
      <div className="mb-3 rounded-md bg-muted p-2">
        <Tag size={28} className="text-muted-foreground" />
      </div>
      <h3 className="mb-1 text-sm font-medium">{t('tagNav.emptyTitle')}</h3>
      <p className="max-w-sm text-center text-sm text-muted-foreground">
        {t('tagNav.emptyDesc1')}
        <br />
        {t('tagNav.emptyDesc2')}
      </p>
    </div>
  );
};

export const TagNavigationView: React.FC<TagNavigationViewProps> = ({
  questions,
  onQuestionClick,
  onStartPracticeByTag,
  className,
}) => {
  const { t } = useTranslation('practice');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());

  // 聚合标签
  const tagGroups = useMemo(() => {
    const tagMap = new Map<string, Question[]>();
    const untaggedQuestions: Question[] = [];
    
    questions.forEach(q => {
      const tags = q.tags || [];
      if (tags.length === 0) {
        untaggedQuestions.push(q);
      } else {
        tags.forEach(tag => {
          if (!tagMap.has(tag)) {
            tagMap.set(tag, []);
          }
          tagMap.get(tag)!.push(q);
        });
      }
    });

    const groups: TagGroup[] = [];
    tagMap.forEach((qs, tag) => {
      const masteredCount = qs.filter(q => q.status === 'mastered').length;
      const reviewCount = qs.filter(q => q.status === 'review').length;
      const newCount = qs.filter(q => q.status === 'new').length;
      
      groups.push({
        tag,
        questions: qs,
        totalCount: qs.length,
        masteredCount,
        reviewCount,
        newCount,
        progressPercent: qs.length > 0 ? (masteredCount / qs.length) * 100 : 0,
      });
    });

    // 按题目数量降序排列
    groups.sort((a, b) => b.totalCount - a.totalCount);
    
    // 如果有未分类题目，添加到末尾
    if (untaggedQuestions.length > 0) {
      const masteredCount = untaggedQuestions.filter(q => q.status === 'mastered').length;
      const reviewCount = untaggedQuestions.filter(q => q.status === 'review').length;
      const newCount = untaggedQuestions.filter(q => q.status === 'new').length;
      
      groups.push({
        tag: '__untagged__',
        questions: untaggedQuestions,
        totalCount: untaggedQuestions.length,
        masteredCount,
        reviewCount,
        newCount,
        progressPercent: untaggedQuestions.length > 0 ? (masteredCount / untaggedQuestions.length) * 100 : 0,
      });
    }
    
    return groups;
  }, [questions]);

  // 搜索过滤
  const filteredGroups = useMemo(() => {
    if (!searchQuery.trim()) return tagGroups;
    const query = searchQuery.toLowerCase();
    return tagGroups.filter(g => g.tag.toLowerCase().includes(query));
  }, [tagGroups, searchQuery]);

  // 原始索引映射
  const originalIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    questions.forEach((q, idx) => map.set(q.id, idx));
    return map;
  }, [questions]);

  // 切换展开
  const toggleExpand = useCallback((tag: string) => {
    setExpandedTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  }, []);

  // 点击题目
  const handleQuestionClick = useCallback((questionId: string) => {
    const index = originalIndexMap.get(questionId);
    if (index !== undefined) {
      onQuestionClick?.(index);
    }
  }, [originalIndexMap, onQuestionClick]);

  // 空状态
  if (tagGroups.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* 统计摘要 + 搜索框 合并行 */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-border/40">
        <TagStatsSummary
          tagGroups={tagGroups}
          questions={questions}
/>
      </div>

      {/* 搜索框 */}
      <div className="flex-shrink-0 px-4 py-2">
        <div className="relative">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('tagNav.searchPlaceholder')}
            className="pl-9 h-8 text-sm bg-muted/30 border-transparent focus:border-border focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-colors"
/>
        </div>
      </div>

      {/* 标签列表 - 更紧凑 */}
      <CustomScrollArea className="flex-1" viewportClassName="px-4 pb-4">
        {filteredGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
            <MagnifyingGlass size={24} className="opacity-60" />
            <p className="text-sm">{t('tagNav.noResults')}</p>
            <NotionButton variant="ghost" size="sm" onClick={() => setSearchQuery('')} className="!h-auto !px-2 !py-1 text-xs">
              {t('common:clear')}
            </NotionButton>
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredGroups.map((group) => (
              <TagGroupCard
                key={group.tag}
                group={group}
                isExpanded={expandedTags.has(group.tag)}
                onToggle={() => toggleExpand(group.tag)}
                onStartPractice={onStartPracticeByTag ? () => onStartPracticeByTag(group.tag) : undefined}
                onQuestionClick={onQuestionClick ? handleQuestionClick : undefined}
                originalIndexMap={originalIndexMap}
/>
            ))}
          </div>
        )}
      </CustomScrollArea>
    </div>
  );
};

export default TagNavigationView;
