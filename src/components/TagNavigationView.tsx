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

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from './custom-scroll-area';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  Tag,
  CaretRight,
  MagnifyingGlass,
  Play,
  Check,
  X,
  Hash,
  Stack,
  TreeStructure,
  CloudFog,
  ArrowsOutLineVertical,
  ArrowsInLineVertical,
  PencilSimple,
  CircleNotch,
  Warning,
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
  /** 标签重命名（可选，向后兼容新增；未提供时不展示重命名入口） */
  onRenameTag?: (oldTag: string, newTag: string) => Promise<void>;
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

const TAG_VIEW_MODE_STORAGE_KEY = 'qbank.tagNav.viewMode';

const readStoredTagViewMode = (): 'tree' | 'cloud' => {
  try {
    const stored = window.localStorage.getItem(TAG_VIEW_MODE_STORAGE_KEY);
    return stored === 'cloud' ? 'cloud' : 'tree';
  } catch {
    return 'tree';
  }
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 搜索命中高亮：按 query 切分并用 <mark> 包裹命中片段 */
const HighlightText: React.FC<{ text: string; query?: string }> = ({ text, query }) => {
  const trimmed = query?.trim();
  if (!trimmed) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(trimmed)})`, 'ig'));
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === trimmed.toLowerCase() ? (
          <mark key={i} className="rounded-[2px] bg-warning/30 px-0 text-inherit">
            {part}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </>
  );
};

/** 列表进入 stagger：延迟随索引递增，封顶避免长列表尾部等待过久 */
const staggerStyle = (index: number): React.CSSProperties => ({
  animationDelay: `${Math.min(index, 16) * 20}ms`,
});

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
    // 允许换行：窄屏下统计项 + 未分类提示单行放不下时折行而非横向溢出
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-1">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
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
  /** 搜索命中高亮词 */
  highlight?: string;
  /** 内联重命名（由父级统一管理状态） */
  onRenameStart?: () => void;
  isRenaming?: boolean;
  renameValue?: string;
  onRenameValueChange?: (value: string) => void;
  onRenameCancel?: () => void;
  onRenameSubmit?: () => void;
  renameBusy?: boolean;
  /** 目标名已存在：确认后将合并两个标签 */
  renameMergePending?: boolean;
}> = ({
  group, isExpanded, onToggle, onStartPractice, onQuestionClick, originalIndexMap, highlight,
  onRenameStart, isRenaming, renameValue, onRenameValueChange, onRenameCancel, onRenameSubmit,
  renameBusy, renameMergePending,
}) => {
  const { t } = useTranslation(['practice', 'common', 'learningHub']);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (isRenaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [isRenaming]);
  // 获取进度颜色
  const getProgressColor = (percent: number) => {
    if (percent >= 80) return 'bg-success';
    if (percent >= 50) return 'bg-info';
    if (percent >= 20) return 'bg-warning';
    return 'bg-muted-foreground';
  };

  return (
    <div className="group">
      {isRenaming ? (
        /* 重命名态：行内 Input 替换标签名（非按钮容器，避免键盘事件被外层按钮吞掉） */
        <div className="rounded-md border border-primary/40 bg-primary/5 px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <Hash size={14} className="flex-shrink-0 text-primary" />
            <Input
              ref={renameInputRef}
              value={renameValue ?? ''}
              onChange={(e) => onRenameValueChange?.(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onRenameSubmit?.();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  onRenameCancel?.();
                }
              }}
              placeholder={t('learningHub:exam.library.renameTagPlaceholder')}
              disabled={renameBusy}
              className="h-7 flex-1 min-w-0 bg-background text-sm"
              aria-label={t('learningHub:exam.library.renameTag')}
            />
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              disabled={renameBusy || !(renameValue ?? '').trim()}
              onClick={onRenameSubmit}
              className="!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 text-success hover:bg-success/10"
              aria-label={t('learningHub:exam.library.confirm')}
              title={t('learningHub:exam.library.confirm')}
            >
              {renameBusy ? <CircleNotch size={14} className="animate-spin" /> : <Check size={14} />}
            </DsButton>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              disabled={renameBusy}
              onClick={onRenameCancel}
              className="!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 text-muted-foreground hover:text-foreground"
              aria-label={t('common:cancel')}
              title={t('common:cancel')}
            >
              <X size={14} />
            </DsButton>
          </div>
          {renameMergePending && (
            <div className="ui-drop-in mt-1.5 flex items-center gap-1.5 text-xs text-warning">
              <Warning size={13} className="flex-shrink-0" />
              {t('learningHub:exam.library.renameTagMergeHint')}
            </div>
          )}
        </div>
      ) : (
      /* 标签头部 - 紧凑行 */
      <DsButton variant="ghost" size="sm" onClick={onToggle} aria-expanded={isExpanded} className="!h-auto !w-full !justify-start !rounded-md !px-2 !py-2 [@media(pointer:coarse)]:!py-3 !text-left hover:bg-accent">
        {/* 展开/收起图标（旋转过渡代替图标切换） */}
        <div className="flex-shrink-0 text-muted-foreground/60">
          <CaretRight
            size={14}
            className={cn(
              'transition-transform duration-200 motion-reduce:transition-none',
              isExpanded && 'rotate-90'
            )}
          />
        </div>

        {/* 标签图标和名称 */}
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <Hash size={14} className="flex-shrink-0 text-primary" />
          <span className="text-sm font-medium truncate">
            {group.tag === '__untagged__'
              ? t('practice:tagPicker.untagged')
              : <HighlightText text={group.tag} query={highlight} />}
          </span>
          <span className="text-xs text-muted-foreground ml-1">{group.totalCount}</span>
          {/* 重命名入口：hover 浮现（触屏常显弱化） */}
          {onRenameStart && (
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={(e) => { e.stopPropagation(); onRenameStart(); }}
              className="!h-5 !w-5 !p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-60 [@media(pointer:coarse)]:!h-9 [@media(pointer:coarse)]:!w-9 text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]"
              aria-label={t('learningHub:exam.library.renameTag')}
              title={t('learningHub:exam.library.renameTag')}
            >
              <PencilSimple size={12} />
            </DsButton>
          )}
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
      </DsButton>
      )}

      {/* 展开内容（挂载入场动画） */}
      {isExpanded && (
        <div className="ui-rise-in ml-5 mt-1 mb-2 pl-3 border-l-2 border-border/40">
          {/* 操作按钮 - 内联式 */}
          <div className="flex items-center gap-2 py-1.5 mb-1">
            {onStartPractice && (
              <DsButton variant="ghost" size="sm" onClick={(event) => { event.stopPropagation(); onStartPractice(); }} className="!h-auto !px-2 !py-1 text-xs text-primary hover:bg-primary/10">
                <Play size={12} />
                {t('tagNav.practice')}
              </DsButton>
            )}
            <span className="text-[11px] text-muted-foreground">
              {t('tagNav.toMaster', { count: group.totalCount - group.masteredCount })}
            </span>
          </div>

          {/* 题目列表 - 超紧凑 */}
          <CustomScrollArea
            className="max-h-48"
            viewportClassName="space-y-0"
            fullHeight={false}
          >
            {group.questions.map((q) => {
              const status = q.status || 'new';
              const statusConfig = STATUS_CONFIG[status];
              const originalIndex = originalIndexMap.get(q.id) || 0;

              return (
                <DsButton
                  key={q.id}
                  variant="ghost" size="sm"
                  onClick={() => onQuestionClick?.(q.id)}
                  disabled={!onQuestionClick}
                  className="!h-auto !w-full !justify-start !rounded-sm !px-2 !py-1.5 [@media(pointer:coarse)]:!py-2.5 !text-left hover:bg-accent [content-visibility:auto] [contain-intrinsic-size:auto_32px]"
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
                </DsButton>
              );
            })}
          </CustomScrollArea>
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
  onRenameTag,
  className,
}) => {
  const { t } = useTranslation(['practice', 'common', 'learningHub']);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());
  // 树形 / 标签云 两种展示模式，偏好持久化
  const [viewMode, setViewMode] = useState<'tree' | 'cloud'>(readStoredTagViewMode);
  // 标签云中当前选中的标签（点击平滑过滤出该标签的题目列表）
  const [cloudSelectedTag, setCloudSelectedTag] = useState<string | null>(null);
  // 标签内联重命名状态（父级统一管理，一次只重命名一个标签）
  const [renamingTag, setRenamingTag] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  // 目标名与现有标签重名：需要第二次确认（确认后合并）
  const [renameMergePending, setRenameMergePending] = useState(false);

  const handleViewModeChange = useCallback((mode: 'tree' | 'cloud') => {
    setViewMode(mode);
    try {
      window.localStorage.setItem(TAG_VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // localStorage 不可用时静默降级为会话内偏好
    }
  }, []);

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

  // 全部展开 / 全部收起（作用于当前搜索结果）
  const allExpanded = filteredGroups.length > 0 && filteredGroups.every(g => expandedTags.has(g.tag));
  const toggleExpandAll = useCallback(() => {
    setExpandedTags(prev => {
      const everyExpanded = filteredGroups.length > 0 && filteredGroups.every(g => prev.has(g.tag));
      if (everyExpanded) return new Set();
      return new Set(filteredGroups.map(g => g.tag));
    });
  }, [filteredGroups]);

  // 标签云选中的标签被搜索过滤掉后自动清除
  useEffect(() => {
    if (cloudSelectedTag && !filteredGroups.some(g => g.tag === cloudSelectedTag)) {
      setCloudSelectedTag(null);
    }
  }, [cloudSelectedTag, filteredGroups]);

  // 数据刷新后正在重命名的标签已不存在（外部删除/改名）时复位重命名态
  useEffect(() => {
    if (renamingTag && !tagGroups.some(g => g.tag === renamingTag)) {
      setRenamingTag(null);
      setRenameMergePending(false);
    }
  }, [renamingTag, tagGroups]);

  const startRename = useCallback((tag: string) => {
    setRenamingTag(tag);
    setRenameValue(tag);
    setRenameMergePending(false);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingTag(null);
    setRenameValue('');
    setRenameMergePending(false);
  }, []);

  const submitRename = useCallback(async () => {
    if (!onRenameTag || !renamingTag || renameBusy) return;
    const next = renameValue.trim();
    // 空名或未改动：直接退出编辑态
    if (!next || next === renamingTag) {
      cancelRename();
      return;
    }
    // 与现有标签重名 → 先提示合并，第二次确认才执行
    const duplicated = tagGroups.some(g => g.tag !== '__untagged__' && g.tag !== renamingTag && g.tag === next);
    if (duplicated && !renameMergePending) {
      setRenameMergePending(true);
      return;
    }
    setRenameBusy(true);
    try {
      await onRenameTag(renamingTag, next);
      showGlobalNotification('success', t('learningHub:exam.library.renameTagSuccess'));
      // 保持新标签的展开状态跟随旧标签
      setExpandedTags(prev => {
        if (!prev.has(renamingTag)) return prev;
        const nextSet = new Set(prev);
        nextSet.delete(renamingTag);
        nextSet.add(next);
        return nextSet;
      });
      setCloudSelectedTag(prev => (prev === renamingTag ? next : prev));
      cancelRename();
    } catch (err: unknown) {
      console.error('[TagNavigationView] rename tag failed:', err);
      showGlobalNotification(
        'error',
        `${t('learningHub:exam.library.renameTagFailed')}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setRenameBusy(false);
    }
  }, [onRenameTag, renamingTag, renameBusy, renameValue, tagGroups, renameMergePending, cancelRename, t]);

  // 输入变化后重名确认态失效（针对新值重新判定）
  const handleRenameValueChange = useCallback((value: string) => {
    setRenameValue(value);
    setRenameMergePending(false);
  }, []);

  // 标签云字号：按题目数在 12-20px 间线性缩放
  const maxGroupCount = useMemo(
    () => filteredGroups.reduce((max, g) => Math.max(max, g.totalCount), 0),
    [filteredGroups]
  );

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

      {/* 搜索框 + 视图切换 + 展开控制 */}
      <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2">
        <div className="relative flex-1 min-w-0">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('tagNav.searchPlaceholder')}
            className={cn(
              'pl-9 h-8 text-sm bg-muted/30 border-transparent focus:border-border focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-colors',
              '[&::-webkit-search-cancel-button]:hidden',
              searchQuery && 'pr-8'
            )}
/>
          {searchQuery && (
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={() => setSearchQuery('')}
              className="!absolute !right-1.5 !top-1/2 !-translate-y-1/2 !h-5 !w-5 !p-0 text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]"
              aria-label={t('learningHub:exam.library.clearSearch')}
              title={t('learningHub:exam.library.clearSearch')}
            >
              <X size={12} />
            </DsButton>
          )}
        </div>

        {/* 树形 / 标签云 切换 */}
        <div className="flex items-center p-0.5 rounded-md bg-muted/30 flex-shrink-0">
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => handleViewModeChange('tree')}
            className={cn('ui-state-colors h-7 w-7 p-0', viewMode === 'tree' && 'bg-background shadow-sm')}
            aria-label={t('learningHub:exam.library.treeView')}
            title={t('learningHub:exam.library.treeView')}
          >
            <TreeStructure size={14} />
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => handleViewModeChange('cloud')}
            className={cn('ui-state-colors h-7 w-7 p-0', viewMode === 'cloud' && 'bg-background shadow-sm')}
            aria-label={t('learningHub:exam.library.cloudView')}
            title={t('learningHub:exam.library.cloudView')}
          >
            <CloudFog size={14} />
          </DsButton>
        </div>

        {/* 全部展开/收起（仅树形模式） */}
        {viewMode === 'tree' && (
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={toggleExpandAll}
            className="!h-7 !w-7 !p-1.5 flex-shrink-0 text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]"
            aria-label={allExpanded ? t('learningHub:exam.library.collapseAll') : t('learningHub:exam.library.expandAll')}
            title={allExpanded ? t('learningHub:exam.library.collapseAll') : t('learningHub:exam.library.expandAll')}
          >
            {allExpanded ? <ArrowsInLineVertical size={14} /> : <ArrowsOutLineVertical size={14} />}
          </DsButton>
        )}
      </div>

      {/* 标签列表 / 标签云 */}
      <CustomScrollArea className="flex-1" viewportClassName="px-4 pb-4">
        {filteredGroups.length === 0 ? (
          <div className="ui-rise-in flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
            <MagnifyingGlass size={24} className="opacity-60" />
            <p className="text-sm">
              {searchQuery.trim()
                ? t('learningHub:exam.library.noMatchFor', { query: searchQuery.trim() })
                : t('tagNav.noResults')}
            </p>
            <DsButton variant="ghost" size="sm" onClick={() => setSearchQuery('')} className="!h-auto !px-2 !py-1 text-xs">
              {t('common:clear')}
            </DsButton>
          </div>
        ) : viewMode === 'cloud' ? (
          // 标签云：字号随题目数缩放，点击平滑过滤出该标签下的题目
          <div key="cloud" className="ui-rise-in">
            <div className="flex flex-wrap items-center gap-1.5 py-1">
              {filteredGroups.map((group, index) => {
                const ratio = maxGroupCount > 0 ? group.totalCount / maxGroupCount : 0;
                const isActive = cloudSelectedTag === group.tag;
                return (
                  <DsButton
                    key={group.tag}
                    variant="ghost"
                    size="sm"
                    onClick={() => setCloudSelectedTag(isActive ? null : group.tag)}
                    style={{ ...staggerStyle(index), fontSize: `${Math.round(12 + ratio * 8)}px` }}
                    className={cn(
                      'ui-rise-in ui-state-colors !h-auto !rounded-full !px-2.5 !py-1 border',
                      isActive
                        ? 'border-primary/50 bg-primary/10 text-primary font-medium'
                        : 'border-border/60 text-foreground/80 hover:border-primary/40 hover:bg-primary/5'
                    )}
                    aria-pressed={isActive}
                  >
                    <Hash size={12} className={cn('opacity-70', isActive && 'text-primary')} />
                    {group.tag === '__untagged__'
                      ? t('tagPicker.untagged')
                      : <HighlightText text={group.tag} query={searchQuery} />}
                    <span className="ml-0.5 text-[0.7em] text-muted-foreground tabular-nums">{group.totalCount}</span>
                  </DsButton>
                );
              })}
            </div>
            {cloudSelectedTag && (() => {
              const selectedGroup = filteredGroups.find(g => g.tag === cloudSelectedTag);
              if (!selectedGroup) return null;
              return (
                <div key={cloudSelectedTag} className="ui-rise-in mt-3 border-t border-border/40 pt-2">
                  <TagGroupCard
                    group={selectedGroup}
                    isExpanded
                    onToggle={() => setCloudSelectedTag(null)}
                    onStartPractice={onStartPracticeByTag ? () => onStartPracticeByTag(selectedGroup.tag) : undefined}
                    onQuestionClick={onQuestionClick ? handleQuestionClick : undefined}
                    originalIndexMap={originalIndexMap}
                    highlight={searchQuery}
                    onRenameStart={onRenameTag && selectedGroup.tag !== '__untagged__' ? () => startRename(selectedGroup.tag) : undefined}
                    isRenaming={renamingTag === selectedGroup.tag}
                    renameValue={renameValue}
                    onRenameValueChange={handleRenameValueChange}
                    onRenameCancel={cancelRename}
                    onRenameSubmit={() => void submitRename()}
                    renameBusy={renameBusy}
                    renameMergePending={renameMergePending}
/>
                </div>
              );
            })()}
          </div>
        ) : (
          <div key="tree" className="space-y-0.5">
            {filteredGroups.map((group, index) => (
              <div key={group.tag} className="ui-rise-in" style={staggerStyle(index)}>
                <TagGroupCard
                  group={group}
                  isExpanded={expandedTags.has(group.tag)}
                  onToggle={() => toggleExpand(group.tag)}
                  onStartPractice={onStartPracticeByTag ? () => onStartPracticeByTag(group.tag) : undefined}
                  onQuestionClick={onQuestionClick ? handleQuestionClick : undefined}
                  originalIndexMap={originalIndexMap}
                  highlight={searchQuery}
                  onRenameStart={onRenameTag && group.tag !== '__untagged__' ? () => startRename(group.tag) : undefined}
                  isRenaming={renamingTag === group.tag}
                  renameValue={renameValue}
                  onRenameValueChange={handleRenameValueChange}
                  onRenameCancel={cancelRename}
                  onRenameSubmit={() => void submitRename()}
                  renameBusy={renameBusy}
                  renameMergePending={renameMergePending}
/>
              </div>
            ))}
          </div>
        )}
      </CustomScrollArea>
    </div>
  );
};

export default TagNavigationView;
