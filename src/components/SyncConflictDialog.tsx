/**
 * 同步冲突解决对话框
 * 
 * 提供 Notion 风格的冲突解决 UI，支持：
 * - 冲突列表展示
 * - 本地/远程版本对比
 * - 解决策略选择
 * - 批量操作
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogDescription, NotionDialogBody, NotionDialogFooter } from '@/components/ui/NotionDialog';
import { NotionButton } from '@/components/ui/NotionButton';
import { Badge } from '@/components/ui/shad/Badge';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Label } from '@/components/ui/shad/Label';
import { Separator } from '@/components/ui/shad/Separator';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/shad/Tabs';
import { Alert, AlertDescription } from '@/components/ui/shad/Alert';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import {
  AlertCircle,
  GitBranch,
  GitMerge,
  Check,
  X,
  Clock,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Loader2,
  FileText,
  Tag,
  Star,
} from 'lucide-react';
import {
  SyncConflict,
  QuestionConflictStrategy,
  QuestionVersion,
  useQuestionBankStore,
} from '@/stores/questionBankStore';

// ============================================================================
// Props 类型定义
// ============================================================================

interface SyncConflictDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  examId: string;
  conflicts: SyncConflict[];
  onResolved?: () => void;
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 获取冲突类型的显示标签和颜色 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getConflictTypeInfo(type: string, t: (...args: any[]) => any): { label: string; color: string } {
  const colorMap: Record<string, string> = {
    modify_modify: 'bg-amber-500',
    modify_delete: 'bg-red-500',
    delete_modify: 'bg-orange-500',
    add_add: 'bg-blue-500',
  };
  const color = colorMap[type] ?? 'bg-gray-500';
  const label = t(`conflictTypes.${type}`, type);
  return { label, color };
}

/** 格式化时间 */
function formatTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

/** 比较两个时间，返回较新的一方 */
function compareTime(time1: string, time2: string): 'local' | 'remote' | 'equal' {
  try {
    const d1 = new Date(time1).getTime();
    const d2 = new Date(time2).getTime();
    if (d1 > d2) return 'local';
    if (d1 < d2) return 'remote';
    return 'equal';
  } catch {
    return 'equal';
  }
}

// ============================================================================
// 版本对比组件
// ============================================================================

interface VersionCompareProps {
  local: QuestionVersion;
  remote: QuestionVersion;
}

function VersionCompare({ local, remote }: VersionCompareProps) {
  const { t } = useTranslation('sync');
  const newerSide = compareTime(local.updated_at, remote.updated_at);

  return (
    <div className="grid grid-cols-2 gap-4">
      {/* 本地版本 */}
      <Card className={`border-2 ${newerSide === 'local' ? 'border-green-500' : 'border-muted'}`}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between">
            <span className="flex items-center gap-2">
              <GitBranch className="h-4 w-4" />
              {t('localVersion', '本地版本')}
            </span>
            {newerSide === 'local' && (
              <Badge variant="secondary" className="bg-green-100 text-green-800">
                {t('newer', '较新')}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <Label className="text-xs text-muted-foreground">{t('content', '题干')}</Label>
            <p className="mt-1 whitespace-pre-wrap line-clamp-3">{local.content}</p>
          </div>
          {local.answer && (
            <div>
              <Label className="text-xs text-muted-foreground">{t('answer', '答案')}</Label>
              <p className="mt-1">{local.answer}</p>
            </div>
          )}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {formatTime(local.updated_at)}
          </div>
          <div className="flex items-center gap-2">
            {local.is_favorite && <Star className="h-3 w-3 text-yellow-500 fill-yellow-500" />}
            {local.tags.length > 0 && (
              <div className="flex items-center gap-1">
                <Tag className="h-3 w-3" />
                <span className="text-xs">{local.tags.length}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 远程版本 */}
      <Card className={`border-2 ${newerSide === 'remote' ? 'border-green-500' : 'border-muted'}`}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between">
            <span className="flex items-center gap-2">
              <GitMerge className="h-4 w-4" />
              {t('remoteVersion', '远程版本')}
            </span>
            {newerSide === 'remote' && (
              <Badge variant="secondary" className="bg-green-100 text-green-800">
                {t('newer', '较新')}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <Label className="text-xs text-muted-foreground">{t('content', '题干')}</Label>
            <p className="mt-1 whitespace-pre-wrap line-clamp-3">{remote.content}</p>
          </div>
          {remote.answer && (
            <div>
              <Label className="text-xs text-muted-foreground">{t('answer', '答案')}</Label>
              <p className="mt-1">{remote.answer}</p>
            </div>
          )}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {formatTime(remote.updated_at)}
          </div>
          <div className="flex items-center gap-2">
            {remote.is_favorite && <Star className="h-3 w-3 text-yellow-500 fill-yellow-500" />}
            {remote.tags.length > 0 && (
              <div className="flex items-center gap-1">
                <Tag className="h-3 w-3" />
                <span className="text-xs">{remote.tags.length}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================================
// 冲突项组件
// ============================================================================

interface ConflictItemProps {
  conflict: SyncConflict;
  isSelected: boolean;
  isExpanded: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onResolve: (strategy: QuestionConflictStrategy) => void;
  isResolving: boolean;
}

function ConflictItem({
  conflict,
  isSelected,
  isExpanded,
  onToggleSelect,
  onToggleExpand,
  onResolve,
  isResolving,
}: ConflictItemProps) {
  const { t } = useTranslation('sync');
  const typeInfo = getConflictTypeInfo(conflict.conflict_type, t);

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* 冲突头部 */}
      <div 
        className="flex items-center gap-3 p-3 bg-muted/50 cursor-pointer hover:bg-muted/80 transition-colors"
        onClick={onToggleExpand}
      >
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelect()}
          onClick={(e) => e.stopPropagation()}
        />
        
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-amber-500" />
            <span className="font-medium truncate">
              {conflict.local_version.content.slice(0, 50)}...
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            <Badge variant="outline" className={`${typeInfo.color} text-white text-xs`}>
              {typeInfo.label}
            </Badge>
            <span>{formatTime(conflict.created_at)}</span>
          </div>
        </div>

        {/* 快捷操作按钮 */}
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <CommonTooltip content={t('keepLocal', '保留本地')}>
            <NotionButton
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onResolve('keep_local')}
              disabled={isResolving}
            >
              <GitBranch className="h-4 w-4" />
            </NotionButton>
          </CommonTooltip>

          <CommonTooltip content={t('keepRemote', '保留远程')}>
            <NotionButton
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onResolve('keep_remote')}
              disabled={isResolving}
            >
              <GitMerge className="h-4 w-4" />
            </NotionButton>
          </CommonTooltip>

          <CommonTooltip content={t('keepNewer', '保留较新')}>
            <NotionButton
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onResolve('keep_newer')}
              disabled={isResolving}
            >
              <Clock className="h-4 w-4" />
            </NotionButton>
          </CommonTooltip>
        </div>
      </div>

      {/* 展开的详情 */}
      {isExpanded && (
        <div className="p-4 space-y-4">
          <VersionCompare
            local={conflict.local_version}
            remote={conflict.remote_version}
          />
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 主对话框组件
// ============================================================================

export function SyncConflictDialog({
  open,
  onOpenChange,
  examId,
  conflicts,
  onResolved,
}: SyncConflictDialogProps) {
  const { t } = useTranslation('sync');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [batchStrategy, setBatchStrategy] = useState<QuestionConflictStrategy>('keep_newer');
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());

  const { resolveSyncConflict, batchResolveSyncConflicts, isSyncing } = useQuestionBankStore();

  // 切换选择
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // 切换展开
  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // 全选/取消全选
  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === conflicts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(conflicts.map((c) => c.id)));
    }
  }, [conflicts, selectedIds.size]);

  // 解决单个冲突
  const handleResolve = useCallback(
    async (conflictId: string, strategy: QuestionConflictStrategy) => {
      setResolvingIds((prev) => new Set(prev).add(conflictId));
      try {
        await resolveSyncConflict(conflictId, strategy);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(conflictId);
          return next;
        });
      } catch (err: unknown) {
        console.error('Failed to resolve conflict:', err);
      } finally {
        setResolvingIds((prev) => {
          const next = new Set(prev);
          next.delete(conflictId);
          return next;
        });
      }
    },
    [resolveSyncConflict]
  );

  // 批量解决
  const handleBatchResolve = useCallback(async () => {
    if (selectedIds.size === 0) return;

    try {
      // 如果选择了全部，使用批量 API
      if (selectedIds.size === conflicts.length) {
        await batchResolveSyncConflicts(examId, batchStrategy);
      } else {
        // 否则逐个解决
        for (const id of selectedIds) {
          await resolveSyncConflict(id, batchStrategy);
        }
      }
      setSelectedIds(new Set());
      onResolved?.();
    } catch (err: unknown) {
      console.error('Failed to batch resolve conflicts:', err);
    }
  }, [
    selectedIds,
    conflicts.length,
    examId,
    batchStrategy,
    batchResolveSyncConflicts,
    resolveSyncConflict,
    onResolved,
  ]);

  // 待处理的冲突
  const pendingConflicts = useMemo(
    () => conflicts.filter((c) => c.status === 'pending'),
    [conflicts]
  );

  return (
    <NotionDialog open={open} onOpenChange={onOpenChange} maxWidth="max-w-4xl">
        <NotionDialogHeader>
          <NotionDialogTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-amber-500" />
            {t('syncConflicts', '同步冲突')}
            <Badge variant="secondary">{pendingConflicts.length}</Badge>
          </NotionDialogTitle>
          <NotionDialogDescription>
            {t('conflictDescription', '以下题目在本地和远程存在冲突，请选择解决策略。')}
          </NotionDialogDescription>
        </NotionDialogHeader>
        <NotionDialogBody nativeScroll>

        {pendingConflicts.length === 0 ? (
          <Alert>
            <Check className="h-4 w-4" />
            <AlertDescription>
              {t('noConflicts', '没有待解决的冲突。')}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {/* 批量操作栏 */}
            <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-3">
                <Checkbox
                  checked={selectedIds.size === pendingConflicts.length && pendingConflicts.length > 0}
                  onCheckedChange={toggleSelectAll}
                />
                <span className="text-sm text-muted-foreground">
                  {selectedIds.size > 0
                    ? t('selectedCount', '已选择 {{count}} 项', { count: selectedIds.size })
                    : t('selectAll', '全选')}
                </span>
              </div>

              {selectedIds.size > 0 && (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-4">
                    {(['keep_local', 'keep_remote', 'keep_newer', 'merge'] as const).map((strategy) => (
                      <label key={strategy} className="flex items-center gap-1.5 cursor-pointer">
                        <Card
                          key={strategy}
                          className={`cursor-pointer transition-all bg-transparent ${
                            batchStrategy === strategy
                              ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                              : 'hover:border-border/60 hover:bg-muted/30 border-muted'
                          }`}
                        >
                          <input
                            type="radio"
                            name="batch-strategy"
                            value={strategy}
                            checked={batchStrategy === strategy}
                            onChange={() => setBatchStrategy(strategy)}
                            className="accent-primary h-4 w-4"
                          />
                          <span className="text-sm">
                            {strategy === 'keep_local' ? t('keepLocal', '保留本地')
                              : strategy === 'keep_remote' ? t('keepRemote', '保留远程')
                              : strategy === 'keep_newer' ? t('keepNewer', '保留较新')
                              : t('merge', '智能合并')}
                          </span>
                        </Card>
                      </label>
                    ))}
                  </div>

                  <NotionButton
                    variant="default"
                    size="sm"
                    onClick={handleBatchResolve}
                    disabled={isSyncing}
                  >
                    {isSyncing ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Check className="h-4 w-4 mr-2" />
                    )}
                    {t('batchResolve', '批量解决')}
                  </NotionButton>
                </div>
              )}
            </div>

            {/* 冲突列表 */}
            <CustomScrollArea className="flex-1 min-h-0">
              <div className="space-y-3 pr-4">
                {pendingConflicts.map((conflict) => (
                  <ConflictItem
                    key={conflict.id}
                    conflict={conflict}
                    isSelected={selectedIds.has(conflict.id)}
                    isExpanded={expandedIds.has(conflict.id)}
                    onToggleSelect={() => toggleSelect(conflict.id)}
                    onToggleExpand={() => toggleExpand(conflict.id)}
                    onResolve={(strategy) => handleResolve(conflict.id, strategy)}
                    isResolving={resolvingIds.has(conflict.id)}
                  />
                ))}
              </div>
            </CustomScrollArea>
          </>
        )}

        </NotionDialogBody>
        <NotionDialogFooter>
          <NotionButton variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('close', '关闭')}
          </NotionButton>
        </NotionDialogFooter>
    </NotionDialog>
  );
}

export default SyncConflictDialog;
