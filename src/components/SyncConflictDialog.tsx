/**
 * 同步冲突解决对话框
 *
 * 提供 Notion 风格的冲突解决 UI，支持：
 * - 冲突列表展示
 * - 本地/远程版本对比
 * - 解决策略选择
 * - 批量操作
 */

import React, { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  NotionDialog,
  NotionDialogHeader,
  NotionDialogTitle,
  NotionDialogDescription,
  NotionDialogBody,
  NotionDialogFooter,
  NotionAlertDialog,
} from "@/components/ui/NotionDialog";
import { NotionButton } from "@/components/ui/NotionButton";
import { Badge } from "@/components/ui/shad/Badge";
import { CustomScrollArea } from "@/components/custom-scroll-area";
import { Label } from "@/components/ui/shad/Label";
import { Separator } from "@/components/ui/shad/Separator";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/shad/Card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/shad/Tabs";
import { Alert, AlertDescription } from "@/components/ui/shad/Alert";
import { Checkbox } from "@/components/ui/shad/Checkbox";
import { CommonTooltip } from "@/components/shared/CommonTooltip";
import {
  WarningCircle,
  GitBranch,
  GitMerge,
  Check,
  X,
  Clock,
  CaretRight,
  CaretDown,
  ArrowClockwise,
  CircleNotch,
  FileText,
  Tag,
  Star,
} from "@phosphor-icons/react";
import { useShallow } from "zustand/react/shallow";
import {
  SyncConflict,
  QuestionConflictStrategy,
  QuestionVersion,
  useQuestionBankStore,
} from "@/stores/questionBankStore";
import { unifiedAlert } from "@/utils/unifiedDialogs";

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

type PendingResolution =
  | {
      kind: "single";
      conflictId: string;
      strategy: QuestionConflictStrategy;
    }
  | {
      kind: "batch";
      conflictIds: string[];
      strategy: QuestionConflictStrategy;
    };

// ============================================================================
// 辅助函数
// ============================================================================

/** 获取冲突类型的显示标签和颜色 */
function getConflictTypeInfo(
  type: string,
  t: (...args: any[]) => any,
): { label: string; color: string } {
  const colorMap: Record<string, string> = {
    modify_modify: "bg-amber-500",
    modify_delete: "bg-red-500",
    delete_modify: "bg-orange-500",
    add_add: "bg-blue-500",
  };
  const color = colorMap[type] ?? "bg-gray-500";
  const label = t(`conflictTypes.${type}`, type);
  return { label, color };
}

/** 格式化时间 */
function formatTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

/** 比较两个时间，返回较新的一方 */
function compareTime(
  time1: string,
  time2: string,
): "local" | "remote" | "equal" {
  try {
    const d1 = new Date(time1).getTime();
    const d2 = new Date(time2).getTime();
    if (d1 > d2) return "local";
    if (d1 < d2) return "remote";
    return "equal";
  } catch {
    return "equal";
  }
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getStrategyLabel(
  strategy: QuestionConflictStrategy,
  t: (...args: any[]) => any,
): string {
  switch (strategy) {
    case "keep_local":
      return t("keepLocal");
    case "keep_remote":
      return t("keepRemote");
    case "keep_newer":
      return t("keepNewer");
    case "merge":
      return t("merge");
    case "manual":
      return t("manual");
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
  const { t } = useTranslation("sync");
  const newerSide = compareTime(local.updated_at, remote.updated_at);

  return (
    <div className="grid grid-cols-2 gap-4">
      {/* 本地版本 */}
      <Card
        className={`border-2 ${newerSide === "local" ? "border-green-500" : "border-muted"}`}
      >
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between">
            <span className="flex items-center gap-2">
              <GitBranch size={16} />
              {t("localVersion")}
            </span>
            {newerSide === "local" && (
              <Badge
                variant="secondary"
                className="bg-green-100 text-green-800"
              >
                {t("newer")}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <Label className="text-xs text-muted-foreground">
              {t("content")}
            </Label>
            <p className="mt-1 whitespace-pre-wrap line-clamp-3">
              {local.content}
            </p>
          </div>
          {local.answer && (
            <div>
              <Label className="text-xs text-muted-foreground">
                {t("answer")}
              </Label>
              <p className="mt-1">{local.answer}</p>
            </div>
          )}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock size={12} />
            {formatTime(local.updated_at)}
          </div>
          <div className="flex items-center gap-2">
            {local.is_favorite && (
              <Star size={12} className="text-yellow-500 fill-yellow-500" />
            )}
            {local.tags.length > 0 && (
              <div className="flex items-center gap-1">
                <Tag size={12} />
                <span className="text-xs">{local.tags.length}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 远程版本 */}
      <Card
        className={`border-2 ${newerSide === "remote" ? "border-green-500" : "border-muted"}`}
      >
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between">
            <span className="flex items-center gap-2">
              <GitMerge size={16} />
              {t("remoteVersion")}
            </span>
            {newerSide === "remote" && (
              <Badge
                variant="secondary"
                className="bg-green-100 text-green-800"
              >
                {t("newer")}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <Label className="text-xs text-muted-foreground">
              {t("content")}
            </Label>
            <p className="mt-1 whitespace-pre-wrap line-clamp-3">
              {remote.content}
            </p>
          </div>
          {remote.answer && (
            <div>
              <Label className="text-xs text-muted-foreground">
                {t("answer")}
              </Label>
              <p className="mt-1">{remote.answer}</p>
            </div>
          )}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock size={12} />
            {formatTime(remote.updated_at)}
          </div>
          <div className="flex items-center gap-2">
            {remote.is_favorite && (
              <Star size={12} className="text-yellow-500 fill-yellow-500" />
            )}
            {remote.tags.length > 0 && (
              <div className="flex items-center gap-1">
                <Tag size={12} />
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
  const { t } = useTranslation("sync");
  const typeInfo = getConflictTypeInfo(conflict.conflict_type, t);

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* 冲突头部 */}
      <div
        className="flex items-center gap-3 p-3 bg-muted/50 cursor-pointer hover:bg-[var(--interactive-hover)] transition-colors"
        onClick={onToggleExpand}
      >
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelect()}
          onClick={(e) => e.stopPropagation()}
        />

        {isExpanded ? (
          <CaretDown size={16} className="text-muted-foreground" />
        ) : (
          <CaretRight size={16} className="text-muted-foreground" />
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <WarningCircle size={16} className="text-amber-500" />
            <span className="font-medium truncate">
              {conflict.local_version.content.slice(0, 50)}...
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            <Badge
              variant="outline"
              className={`${typeInfo.color} text-white text-xs`}
            >
              {typeInfo.label}
            </Badge>
            <span>{formatTime(conflict.created_at)}</span>
          </div>
        </div>

        {/* 快捷操作按钮 */}
        <div
          className="flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <CommonTooltip content={t("keepLocal")}>
            <NotionButton
              variant="ghost"
              size="icon"
              className="w-8 h-8"
              onClick={() => onResolve("keep_local")}
              disabled={isResolving}
            >
              <GitBranch size={16} />
            </NotionButton>
          </CommonTooltip>

          <CommonTooltip content={t("keepRemote")}>
            <NotionButton
              variant="ghost"
              size="icon"
              className="w-8 h-8"
              onClick={() => onResolve("keep_remote")}
              disabled={isResolving}
            >
              <GitMerge size={16} />
            </NotionButton>
          </CommonTooltip>

          <CommonTooltip content={t("keepNewer")}>
            <NotionButton
              variant="ghost"
              size="icon"
              className="w-8 h-8"
              onClick={() => onResolve("keep_newer")}
              disabled={isResolving}
            >
              <Clock size={16} />
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
  const { t } = useTranslation("sync");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [batchStrategy, setBatchStrategy] =
    useState<QuestionConflictStrategy>("keep_newer");
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());
  const [pendingResolution, setPendingResolution] =
    useState<PendingResolution | null>(null);
  const [isConfirmingResolution, setIsConfirmingResolution] = useState(false);

  const { resolveSyncConflict, batchResolveSyncConflicts, isSyncing } =
    useQuestionBankStore(
      useShallow((state) => ({
        resolveSyncConflict: state.resolveSyncConflict,
        batchResolveSyncConflicts: state.batchResolveSyncConflicts,
        isSyncing: state.isSyncing,
      })),
    );

  // 待处理的冲突
  const pendingConflicts = useMemo(
    () => conflicts.filter((c) => c.status === "pending"),
    [conflicts],
  );

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
    if (selectedIds.size === pendingConflicts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pendingConflicts.map((c) => c.id)));
    }
  }, [pendingConflicts, selectedIds.size]);

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
        onResolved?.();
      } catch (err: unknown) {
        const message = getErrorMessage(err);
        console.error("Failed to resolve conflict:", err);
        unifiedAlert(
          t("notifications.conflictResolveFailed", { error: message }),
          "error",
        );
      } finally {
        setResolvingIds((prev) => {
          const next = new Set(prev);
          next.delete(conflictId);
          return next;
        });
      }
    },
    [resolveSyncConflict, onResolved, t],
  );

  // 批量解决
  const handleBatchResolve = useCallback(async (
    conflictIds: string[],
    strategy: QuestionConflictStrategy,
  ) => {
    if (conflictIds.length === 0) return;

    try {
      // 如果选择了全部，使用批量 API
      if (conflictIds.length === pendingConflicts.length) {
        const result = await batchResolveSyncConflicts(examId, strategy);
        // ★ #20(round2): 显式提示部分失败（此前仅后端 warn，前端无感知）
        if (result.failed.length > 0) {
          unifiedAlert(
            t("notifications.conflictBatchResolvePartial", {
              resolved: result.resolved.length,
              failed: result.failed.length,
            }),
            "warning",
          );
        }
      } else {
        // 否则逐个解决
        for (const id of conflictIds) {
          await resolveSyncConflict(id, strategy);
        }
      }
      setSelectedIds(new Set());
      onResolved?.();
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      console.error("Failed to batch resolve conflicts:", err);
      unifiedAlert(
        t("notifications.conflictBatchResolveFailed", { error: message }),
        "error",
      );
    }
  }, [
    pendingConflicts.length,
    examId,
    batchResolveSyncConflicts,
    resolveSyncConflict,
    onResolved,
    t,
  ]);

  const requestSingleResolve = useCallback(
    (conflictId: string, strategy: QuestionConflictStrategy) => {
      setPendingResolution({ kind: "single", conflictId, strategy });
    },
    [],
  );

  const requestBatchResolve = useCallback(() => {
    if (selectedIds.size === 0) return;
    setPendingResolution({
      kind: "batch",
      conflictIds: Array.from(selectedIds),
      strategy: batchStrategy,
    });
  }, [selectedIds, batchStrategy]);

  const handleConfirmResolution = useCallback(async () => {
    if (!pendingResolution) return;

    setIsConfirmingResolution(true);
    try {
      if (pendingResolution.kind === "single") {
        await handleResolve(pendingResolution.conflictId, pendingResolution.strategy);
      } else {
        await handleBatchResolve(
          pendingResolution.conflictIds,
          pendingResolution.strategy,
        );
      }
      setPendingResolution(null);
    } finally {
      setIsConfirmingResolution(false);
    }
  }, [pendingResolution, handleResolve, handleBatchResolve]);

  const handleResolutionDialogOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen && !isConfirmingResolution) {
      setPendingResolution(null);
    }
  }, [isConfirmingResolution]);

  return (
    <NotionDialog open={open} onOpenChange={onOpenChange} maxWidth="max-w-4xl">
      <NotionDialogHeader>
        <NotionDialogTitle className="flex items-center gap-2">
          <WarningCircle size={20} className="text-amber-500" />
          {t("syncConflicts")}
          <Badge variant="secondary">{pendingConflicts.length}</Badge>
        </NotionDialogTitle>
        <NotionDialogDescription>
          {t(
            "conflictDescription",
            "conflictDescription",
          )}
        </NotionDialogDescription>
      </NotionDialogHeader>
      <NotionDialogBody>
        {pendingConflicts.length === 0 ? (
          <Alert>
            <Check size={16} />
            <AlertDescription>
              {t("noConflicts")}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {/* 批量操作栏 */}
            <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-3">
                <Checkbox
                  checked={
                    selectedIds.size === pendingConflicts.length &&
                    pendingConflicts.length > 0
                  }
                  onCheckedChange={toggleSelectAll}
                />
                <span className="text-sm text-muted-foreground">
                  {selectedIds.size > 0
                    ? t("selectedCount", {
                        count: selectedIds.size,
                      })
                    : t("selectAll")}
                </span>
              </div>

              {selectedIds.size > 0 && (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-4">
                    {(
                      [
                        "keep_local",
                        "keep_remote",
                        "keep_newer",
                        "merge",
                      ] as const
                    ).map((strategy) => (
                      <label
                        key={strategy}
                        className="flex items-center gap-1.5 cursor-pointer"
                      >
                        <Card
                          key={strategy}
                          className={`cursor-pointer transition-all bg-transparent ${
                            batchStrategy === strategy
                              ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                              : "hover:border-border/60 hover:bg-[var(--interactive-hover)] border-muted"
                          }`}
                        >
                          <input
                            type="radio"
                            name="batch-strategy"
                            value={strategy}
                            checked={batchStrategy === strategy}
                            onChange={() => setBatchStrategy(strategy)}
                            size={16}
                            className="accent-primary"
                          />
                          <span className="text-sm">
                            {strategy === "keep_local"
                              ? t("keepLocal")
                              : strategy === "keep_remote"
                                ? t("keepRemote")
                                : strategy === "keep_newer"
                                  ? t("keepNewer")
                                  : t("merge")}
                          </span>
                        </Card>
                      </label>
                    ))}
                  </div>

                  <NotionButton
                    variant="default"
                    size="sm"
                    onClick={requestBatchResolve}
                    disabled={isSyncing || isConfirmingResolution}
                  >
                    {isSyncing ? (
                      <CircleNotch size={16} className="animate-spin mr-2" />
                    ) : (
                      <Check size={16} className="mr-2" />
                    )}
                    {t("batchResolve")}
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
                    onResolve={(strategy) =>
                      requestSingleResolve(conflict.id, strategy)
                    }
                    isResolving={resolvingIds.has(conflict.id)}
                  />
                ))}
              </div>
            </CustomScrollArea>
          </>
        )}
      </NotionDialogBody>
      <NotionDialogFooter>
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={() => onOpenChange(false)}
        >
          {t("close")}
        </NotionButton>
      </NotionDialogFooter>
      <NotionAlertDialog
        open={pendingResolution !== null}
        onOpenChange={handleResolutionDialogOpenChange}
        icon={<WarningCircle size={20} className="text-amber-500" />}
        title={t("confirmConflictResolveTitle")}
        description={pendingResolution
          ? pendingResolution.kind === "single"
            ? t(
              "confirmConflictResolveDescription",
              "confirmConflictResolveDescription",
              { strategy: getStrategyLabel(pendingResolution.strategy, t) },
            )
            : t(
              "confirmConflictBatchResolveDescription",
              "confirmConflictBatchResolveDescription",
              {
                count: pendingResolution.conflictIds.length,
                strategy: getStrategyLabel(pendingResolution.strategy, t),
              },
            )
          : undefined}
        confirmText={t("confirm")}
        cancelText={t("cancel")}
        confirmVariant="warning"
        onConfirm={() => void handleConfirmResolution()}
        loading={isConfirmingResolution}
      />
    </NotionDialog>
  );
}

export default SyncConflictDialog;
