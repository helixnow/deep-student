/**
 * 题组与共享材料结构管理
 *
 * 单一数据源：`qbank_list_structure(examId)`。所有写操作携带结构版本做 OCC：
 * - 调整成员顺序 / 加入 / 移出成员 / 编辑标签 / 关联材料 → qbank_update_group
 * - 解散题组（保留子题与材料）或删除题组及子题 → qbank_delete_group
 * - 删除未被任何题组引用的材料 → qbank_delete_material
 *
 * 变更成功后重新读取结构并派发 `qbank:refresh`，让题目集规范视图刷新；
 * 版本冲突时不覆盖任何内容，显示冲突提示并自动载入最新结构。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  ArrowDown,
  ArrowUp,
  ArrowsIn,
  BookOpen,
  Check,
  CircleNotch,
  LinkSimple,
  ListChecks,
  PencilSimple,
  Plus,
  Trash,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/shad/Input';
import { DsButton } from '@/components/ui/DsButton';
import {
  DsDialog,
  DsDialogBody,
  DsDialogDescription,
  DsDialogFooter,
  DsDialogHeader,
  DsDialogTitle,
} from '@/components/ui/DsDialog';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  deleteQuestionGroup,
  deleteQuestionMaterial,
  getQuestionBankStructure,
  updateQuestionGroup,
  type Question,
  type QuestionBankStructure,
  type QuestionMaterial,
  type QuestionStructureGroup,
} from '@/api/questionBankApi';

export interface QuestionStructureManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  examId: string;
  /**
   * 题目集全量题目（不要传筛选后的子集）。用于成员预览、可加入题目候选；
   * 结构与成员关系仍以 qbank_list_structure 为准。
   */
  questions: Question[];
  /** 写操作成功后的宿主刷新回调（可选；组件本身也会派发 qbank:refresh） */
  onChanged?: () => void | Promise<void>;
  /** 只读模式隐藏全部写操作 */
  editable?: boolean;
}

type ConfirmState =
  | {
      kind: 'dissolve_group' | 'delete_group';
      groupId: string;
      label: string;
      count: number;
      version: number;
    }
  | {
      kind: 'delete_material';
      materialId: string;
      preview: string;
      version: number;
    };

type MutationOutcome =
  | { ok: true }
  | { ok: false; conflict: boolean; message: string };

function errorMessageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/** 后端冲突错误文案包含「版本已变化」/ conflict 等关键词 */
function isVersionConflict(message: string): boolean {
  return /版本|冲突|version|conflict|stale/i.test(message);
}

function notifyCanonicalRefresh(action: string) {
  try {
    window.dispatchEvent(
      new CustomEvent('qbank:refresh', {
        detail: { source: 'user', action },
      }),
    );
  } catch {
    // 派发失败不阻断已成功的写操作；宿主仍可通过 onChanged / 域事件刷新
  }
}

function compactText(value: string | null | undefined, max = 64): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function QuestionStructureManager({
  open,
  onOpenChange,
  examId,
  questions,
  onChanged,
  editable = true,
}: QuestionStructureManagerProps) {
  const { t } = useTranslation('practice');
  const [structure, setStructure] = useState<QuestionBankStructure | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [addingGroupId, setAddingGroupId] = useState<string | null>(null);
  const [candidateQuery, setCandidateQuery] = useState('');
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const loadSeqRef = useRef(0);
  const busyRef = useRef<string | null>(null);

  const loadStructure = useCallback(async (options?: { silent?: boolean }) => {
    const seq = ++loadSeqRef.current;
    if (!options?.silent) setLoading(true);
    setLoadError(null);
    try {
      const next = await getQuestionBankStructure(examId);
      if (seq !== loadSeqRef.current) return;
      setStructure(next);
    } catch (error) {
      if (seq !== loadSeqRef.current) return;
      setLoadError(errorMessageOf(error));
    } finally {
      if (seq === loadSeqRef.current && !options?.silent) setLoading(false);
    }
  }, [examId]);

  useEffect(() => {
    if (!open) {
      // 取消在途请求的回填，避免关闭后旧响应覆盖下次打开的数据
      loadSeqRef.current += 1;
      setStructure(null);
      setLoading(false);
      setLoadError(null);
      setActionError(null);
      setBusyKey(null);
      busyRef.current = null;
      setEditingGroupId(null);
      setAddingGroupId(null);
      setCandidateQuery('');
      setConfirm(null);
      return;
    }
    void loadStructure();
  }, [open, loadStructure]);

  const questionById = useMemo(() => {
    const map = new Map<string, Question>();
    for (const question of questions) map.set(question.id, question);
    return map;
  }, [questions]);

  const orderedGroups = useMemo(() => {
    if (!structure) return [];
    return [...structure.groups].sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      return a.id.localeCompare(b.id);
    });
  }, [structure]);

  const groupedQuestionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of structure?.groups ?? []) {
      for (const id of group.question_ids) ids.add(id);
    }
    return ids;
  }, [structure]);

  const usedMaterialIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of structure?.groups ?? []) {
      for (const id of group.material_ids) ids.add(id);
    }
    return ids;
  }, [structure]);

  const unusedMaterials = useMemo(
    () => (structure?.materials ?? []).filter((material) => !usedMaterialIds.has(material.id)),
    [structure, usedMaterialIds],
  );

  const questionPreview = useCallback((questionId: string): string => {
    const question = questionById.get(questionId);
    if (!question) return questionId;
    const label = compactText(question.questionLabel, 24);
    const content = compactText(question.content || question.ocrText, 72);
    if (label && content) return `${label} · ${content}`;
    return label || content || t('questionBank.structure.unnamedQuestion', {
      defaultValue: '未命名题目',
    });
  }, [questionById, t]);

  const materialPreview = useCallback((material: QuestionMaterial, index: number): string => {
    return compactText(material.content, 56)
      || t('questionBank.structure.materialFallback', {
        index: index + 1,
        defaultValue: '材料 {{index}}',
      });
  }, [t]);

  const candidatesFor = useCallback((group: QuestionStructureGroup): Question[] => {
    // 以结构中的成员关系为准（不要依赖题目对象上可能过期的 groupId）。
    // 已属于其他题组的题目不会被后端允许移入，因此不出现在候选中。
    return questions.filter((question) => !groupedQuestionIds.has(question.id));
  }, [groupedQuestionIds, questions]);

  const runMutation = useCallback(async (
    key: string,
    action: () => Promise<unknown>,
    options: { reason: string; successKey?: string },
  ): Promise<MutationOutcome> => {
    if (busyRef.current) {
      return { ok: false, conflict: false, message: t('questionBank.structure.busy', {
        defaultValue: '正在处理上一项操作，请稍候',
      }) };
    }
    busyRef.current = key;
    setBusyKey(key);
    setActionError(null);

    try {
      await action();
    } catch (error) {
      const message = errorMessageOf(error);
      const conflict = isVersionConflict(message);
      setActionError({ message, conflict });
      if (conflict) {
        // 保留冲突提示，同时拉取最新版本，用户确认后可重试
        await loadStructure({ silent: true });
      }
      busyRef.current = null;
      setBusyKey(null);
      return { ok: false, conflict, message };
    }

    await loadStructure({ silent: true });
    busyRef.current = null;
    setBusyKey(null);
    notifyCanonicalRefresh(options.reason);
    if (onChanged) {
      try {
        await onChanged();
      } catch {
        // 宿主刷新失败不影响已成功的写操作，域事件仍会触发一次刷新
      }
    }
    if (options.successKey) {
      showGlobalNotification('success', t(options.successKey));
    }
    return { ok: true };
  }, [loadStructure, onChanged, t]);

  const commitGroup = useCallback(async (
    group: QuestionStructureGroup,
    patch: { label?: string; questionIds?: string[]; materialIds?: string[] },
    successKey?: string,
  ): Promise<MutationOutcome> => {
    const label = (patch.label ?? group.label ?? '').trim();
    return runMutation(
      `group:${group.id}`,
      () => updateQuestionGroup(group.id, {
        label,
        questionIds: patch.questionIds ?? group.question_ids,
        materialIds: patch.materialIds ?? group.material_ids,
        expectedVersion: group.version,
      }),
      { reason: 'group_updated', successKey },
    );
  }, [runMutation]);

  const handleMoveMember = useCallback((group: QuestionStructureGroup, index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= group.question_ids.length) return;
    const next = [...group.question_ids];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    void commitGroup(group, { questionIds: next });
  }, [commitGroup]);

  const handleRemoveMember = useCallback((group: QuestionStructureGroup, questionId: string) => {
    if (group.question_ids.length <= 1) return;
    void commitGroup(group, {
      questionIds: group.question_ids.filter((id) => id !== questionId),
    });
  }, [commitGroup]);

  const handleAddMember = useCallback((group: QuestionStructureGroup, questionId: string) => {
    if (group.question_ids.includes(questionId)) return;
    void commitGroup(group, { questionIds: [...group.question_ids, questionId] });
  }, [commitGroup]);

  const handleSaveLabel = useCallback(async (group: QuestionStructureGroup) => {
    const label = labelDraft.trim();
    if (!label) return;
    const outcome = await commitGroup(group, { label });
    if (outcome.ok) {
      setEditingGroupId(null);
      setLabelDraft('');
    }
  }, [commitGroup, labelDraft]);

  const handleToggleMaterial = useCallback((group: QuestionStructureGroup, materialId: string) => {
    const linked = group.material_ids.includes(materialId);
    const materialIds = linked
      ? group.material_ids.filter((id) => id !== materialId)
      : [...group.material_ids, materialId];
    void commitGroup(group, { materialIds });
  }, [commitGroup]);

  const handleConfirm = useCallback(async () => {
    if (!confirm) return;
    const current = confirm;
    const key = current.kind === 'delete_material'
      ? `material:${current.materialId}`
      : `group:${current.groupId}`;

    const outcome = current.kind === 'delete_material'
      ? await runMutation(
          key,
          () => deleteQuestionMaterial(current.materialId, current.version),
          { reason: 'material_deleted', successKey: 'questionBank.structure.materialDeleted' },
        )
      : await runMutation(
          key,
          () => deleteQuestionGroup(
            current.groupId,
            current.kind === 'dissolve_group' ? 'ungroup' : 'delete_members',
            current.version,
          ),
          {
            reason: current.kind === 'dissolve_group' ? 'group_dissolved' : 'group_deleted',
            successKey: current.kind === 'dissolve_group'
              ? 'questionBank.structure.groupDissolved'
              : 'questionBank.structure.groupDeleted',
          },
        );

    // 版本冲突：关闭确认框，让顶部冲突提示（已自动载入最新版本）可见
    if (outcome.ok || ('conflict' in outcome && outcome.conflict)) {
      setConfirm(null);
    }
  }, [confirm, runMutation]);

  const dialogTitle = t('questionBank.structure.title', {
    defaultValue: '题组与材料',
  });

  const confirmCopy = confirm
    ? confirm.kind === 'delete_material'
      ? {
          title: t('questionBank.structure.deleteMaterialConfirmTitle', {
            defaultValue: '删除未使用材料',
          }),
          description: t('questionBank.structure.deleteMaterialConfirmDesc', {
            defaultValue: '将删除材料「{{preview}}」，此操作无法撤销。',
            preview: confirm.preview,
          }),
          confirmText: t('questionBank.structure.confirmDelete', { defaultValue: '删除' }),
          variant: 'danger' as const,
        }
      : confirm.kind === 'dissolve_group'
        ? {
            title: t('questionBank.structure.dissolveConfirmTitle', { defaultValue: '解散题组' }),
            description: t('questionBank.structure.dissolveConfirmDesc', {
              defaultValue: '题组「{{label}}」将被解散，{{count}} 道子题会保留为独立题目，共享材料不会被删除。',
              label: confirm.label,
              count: confirm.count,
            }),
            confirmText: t('questionBank.structure.confirmDissolve', { defaultValue: '解散' }),
            variant: 'warning' as const,
          }
        : {
            title: t('questionBank.structure.deleteGroupConfirmTitle', {
              defaultValue: '删除题组及子题',
            }),
            description: t('questionBank.structure.deleteGroupConfirmDesc', {
              defaultValue: '将删除题组「{{label}}」及其中 {{count}} 道子题，此操作无法撤销。',
              label: confirm.label,
              count: confirm.count,
            }),
            confirmText: t('questionBank.structure.confirmDelete', { defaultValue: '删除' }),
            variant: 'danger' as const,
          }
    : null;

  const renderActionError = (className?: string) => {
    if (!actionError) return null;
    return (
      <div
        role="alert"
        className={cn(
          'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs',
          actionError.conflict
            ? 'border-warning/40 bg-warning/10 text-foreground'
            : 'border-destructive/30 bg-destructive/5 text-foreground',
          className,
        )}
      >
        <WarningCircle
          size={15}
          className={cn('mt-0.5 flex-shrink-0', actionError.conflict ? 'text-warning' : 'text-destructive')}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          {actionError.conflict
            ? t('questionBank.structure.versionConflict', {
                defaultValue: '内容已被其他操作修改，已重新载入最新结构。请确认后重试。',
              })
            : t('questionBank.structure.actionFailed', {
                defaultValue: '操作失败：{{message}}',
                message: actionError.message,
              })}
        </span>
        <DsButton
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t('common:actions.close', { defaultValue: '关闭' })}
          className="!h-6 !w-6 flex-shrink-0 !p-0 text-muted-foreground"
          onClick={() => setActionError(null)}
        >
          <X size={12} />
        </DsButton>
      </div>
    );
  };

  return (
    <>
      <DsDialog
        open={open}
        onOpenChange={onOpenChange}
        maxWidth="max-w-2xl"
        aria-label={dialogTitle}
      >
        <DsDialogHeader>
          <DsDialogTitle>{dialogTitle}</DsDialogTitle>
          <DsDialogDescription>
            {t('questionBank.structure.description', {
              defaultValue: '管理题组成员与顺序、关联共享材料，以及解散或删除题组。',
            })}
          </DsDialogDescription>
        </DsDialogHeader>

        <DsDialogBody className="space-y-3 py-4">
          {renderActionError()}
          {loadError && structure && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
            >
              <WarningCircle size={15} className="flex-shrink-0 text-warning" aria-hidden="true" />
              <span className="min-w-0 flex-1 break-all">
                {t('questionBank.structure.refreshFailed', {
                  defaultValue: '刷新结构失败：{{message}}',
                  message: loadError,
                })}
              </span>
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => void loadStructure()}
                className="!h-7 flex-shrink-0 !px-1.5 text-xs"
              >
                {t('questionBank.structure.reload', { defaultValue: '重新载入' })}
              </DsButton>
            </div>
          )}

          {loading && !structure ? (
            <div role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <CircleNotch size={16} className="animate-spin" aria-hidden="true" />
              {t('questionBank.structure.loading', { defaultValue: '加载题组结构…' })}
            </div>
          ) : loadError && !structure ? (
            <div role="alert" className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-xs">
              <span className="flex items-center gap-1.5 text-foreground">
                <WarningCircle size={15} className="text-destructive" aria-hidden="true" />
                {t('questionBank.structure.loadFailed', { defaultValue: '加载题组结构失败' })}
              </span>
              <span className="break-all text-muted-foreground">{loadError}</span>
              <DsButton variant="ghost" size="sm" onClick={() => void loadStructure()}>
                <ArrowClockwise size={13} />
                {t('questionBank.structure.reload', { defaultValue: '重新载入' })}
              </DsButton>
            </div>
          ) : structure && orderedGroups.length === 0 ? (
            <div className="rounded-lg border border-border/50 bg-muted/10 px-4 py-8 text-center">
              <ListChecks size={24} className="mx-auto mb-2 text-muted-foreground/50" aria-hidden="true" />
              <p className="text-sm text-foreground">
                {t('questionBank.structure.emptyGroups', { defaultValue: '还没有题组' })}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('questionBank.structure.emptyGroupsHint', {
                  defaultValue: '导入或创建包含共享材料的题组后，可在这里调整结构与材料关联。',
                })}
              </p>
            </div>
          ) : structure ? (
            orderedGroups.map((group) => {
              const groupBusy = busyKey === `group:${group.id}`;
              const editing = editingGroupId === group.id;
              const adding = addingGroupId === group.id;
              const groupLabel = group.label?.trim()
                || t('questionBank.structure.groupFallback', { defaultValue: '题组' });
              const candidates = candidatesFor(group);
              const query = candidateQuery.trim().toLowerCase();
              const filteredCandidates = (query
                ? candidates.filter((question) => {
                    const haystack = `${question.questionLabel ?? ''} ${question.content ?? ''} ${question.ocrText ?? ''}`.toLowerCase();
                    return haystack.includes(query);
                  })
                : candidates
              ).slice(0, 50);

              return (
                <section
                  key={group.id}
                  aria-label={groupLabel}
                  className="rounded-xl border border-border/50 bg-card/30"
                >
                  <div className="flex flex-wrap items-center gap-1.5 border-b border-border/40 px-3 py-2">
                    <ListChecks size={14} className="flex-shrink-0 text-primary" aria-hidden="true" />
                    {editing ? (
                      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                        <Input
                          value={labelDraft}
                          onChange={(event) => setLabelDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void handleSaveLabel(group);
                            }
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              setEditingGroupId(null);
                              setLabelDraft('');
                            }
                          }}
                          aria-label={t('questionBank.structure.labelPlaceholder', {
                            defaultValue: '题组名称',
                          })}
                          placeholder={t('questionBank.structure.labelPlaceholder', {
                            defaultValue: '题组名称',
                          })}
                          className="h-8 min-w-[8rem] flex-1 text-sm [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]"
                          maxLength={120}
                          autoFocus
                        />
                        <DsButton
                          variant="primary"
                          size="sm"
                          disabled={!labelDraft.trim() || groupBusy || Boolean(busyKey)}
                          onClick={() => void handleSaveLabel(group)}
                          className="lg:!h-8"
                        >
                          {groupBusy && <CircleNotch size={12} className="animate-spin" aria-hidden="true" />}
                          {t('questionBank.structure.save', { defaultValue: '保存' })}
                        </DsButton>
                        <DsButton
                          variant="ghost"
                          size="sm"
                          disabled={groupBusy}
                          onClick={() => {
                            setEditingGroupId(null);
                            setLabelDraft('');
                          }}
                          className="lg:!h-8 text-muted-foreground"
                        >
                          {t('questionBank.structure.cancel', { defaultValue: '取消' })}
                        </DsButton>
                      </div>
                    ) : (
                      <>
                        <div className="flex min-w-0 flex-1 items-center gap-1.5">
                          <h4 className="min-w-0 truncate text-sm font-medium text-foreground">
                            {groupLabel}
                          </h4>
                          <span className="flex-shrink-0 text-2xs tabular-nums text-muted-foreground">
                            {t('questionBank.structure.questionCount', {
                              count: group.question_ids.length,
                              defaultValue: '{{count}} 道子题',
                            })}
                          </span>
                        </div>
                        {editable && (
                          <DsButton
                            variant="ghost"
                            size="sm"
                            iconOnly
                            disabled={Boolean(busyKey)}
                            aria-label={t('questionBank.structure.editLabel', {
                              defaultValue: '编辑题组名称',
                            })}
                            title={t('questionBank.structure.editLabel', {
                              defaultValue: '编辑题组名称',
                            })}
                            onClick={() => {
                              setEditingGroupId(group.id);
                              setLabelDraft(group.label ?? '');
                              setAddingGroupId(null);
                            }}
                            className="lg:!h-7 lg:!w-7 !p-0 text-muted-foreground hover:text-foreground"
                          >
                            <PencilSimple size={13} />
                          </DsButton>
                        )}
                      </>
                    )}
                  </div>

                  <div className="space-y-2 px-3 py-2.5">
                    <ul className="space-y-1">
                      {group.question_ids.map((questionId, index) => {
                        const isFirst = index === 0;
                        const isLast = index === group.question_ids.length - 1;
                        const onlyMember = group.question_ids.length <= 1;
                        return (
                          <li
                            key={questionId}
                            className="flex items-center gap-1.5 rounded-md bg-muted/20 px-2 py-1.5"
                          >
                            <span className="w-4 flex-shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
                              {index + 1}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={questionPreview(questionId)}>
                              {questionPreview(questionId)}
                            </span>
                            {editable && (
                              <div className="flex flex-shrink-0 items-center gap-0.5">
                                <DsButton
                                  variant="ghost"
                                  size="sm"
                                  iconOnly
                                  disabled={isFirst || Boolean(busyKey)}
                                  aria-label={t('questionBank.structure.moveUp', { defaultValue: '上移' })}
                                  title={t('questionBank.structure.moveUp', { defaultValue: '上移' })}
                                  onClick={() => handleMoveMember(group, index, -1)}
                                  className="lg:!h-7 lg:!w-7 !p-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
                                >
                                  <ArrowUp size={12} />
                                </DsButton>
                                <DsButton
                                  variant="ghost"
                                  size="sm"
                                  iconOnly
                                  disabled={isLast || Boolean(busyKey)}
                                  aria-label={t('questionBank.structure.moveDown', { defaultValue: '下移' })}
                                  title={t('questionBank.structure.moveDown', { defaultValue: '下移' })}
                                  onClick={() => handleMoveMember(group, index, 1)}
                                  className="lg:!h-7 lg:!w-7 !p-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
                                >
                                  <ArrowDown size={12} />
                                </DsButton>
                                <DsButton
                                  variant="ghost"
                                  size="sm"
                                  iconOnly
                                  disabled={onlyMember || Boolean(busyKey)}
                                  aria-label={t('questionBank.structure.removeMember', { defaultValue: '移出题组' })}
                                  title={onlyMember
                                    ? t('questionBank.structure.lastMemberHint', {
                                        defaultValue: '题组至少保留一道子题；如需清空请解散或删除题组',
                                      })
                                    : t('questionBank.structure.removeMember', { defaultValue: '移出题组' })}
                                  onClick={() => handleRemoveMember(group, questionId)}
                                  className="lg:!h-7 lg:!w-7 !p-0 text-muted-foreground hover:text-destructive disabled:opacity-30"
                                >
                                  <X size={12} />
                                </DsButton>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>

                    {editable && group.question_ids.length <= 1 && (
                      <p className="text-2xs text-muted-foreground">
                        {t('questionBank.structure.lastMemberHint', {
                          defaultValue: '题组至少保留一道子题；如需清空请解散或删除题组',
                        })}
                      </p>
                    )}

                    {editable && (
                      <div>
                        <DsButton
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            const next = adding ? null : group.id;
                            setAddingGroupId(next);
                            if (next) {
                              setCandidateQuery('');
                              setEditingGroupId(null);
                            }
                          }}
                          aria-expanded={adding}
                          className="lg:!h-8 !px-1.5 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <Plus size={12} />
                          {t('questionBank.structure.addMember', { defaultValue: '添加子题' })}
                        </DsButton>
                        {adding && (
                          <div className="mt-1 rounded-lg border border-border/50 bg-background/60 p-2">
                            <Input
                              type="search"
                              value={candidateQuery}
                              onChange={(event) => setCandidateQuery(event.target.value)}
                              aria-label={t('questionBank.structure.addMemberPlaceholder', {
                                defaultValue: '搜索可添加的题目…',
                              })}
                              placeholder={t('questionBank.structure.addMemberPlaceholder', {
                                defaultValue: '搜索可添加的题目…',
                              })}
                              className="h-8 text-xs [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]"
                            />
                            <p className="mt-1 text-2xs text-muted-foreground">
                              {t('questionBank.structure.addMemberHint', {
                                defaultValue: '只能加入未分组的题目',
                              })}
                            </p>
                            <div className="scroll-area--native mt-1 max-h-44 space-y-0.5 overflow-y-auto">
                              {filteredCandidates.length === 0 ? (
                                <p className="px-1 py-2 text-xs text-muted-foreground">
                                  {t('questionBank.structure.noCandidates', {
                                    defaultValue: '没有可添加的题目',
                                  })}
                                </p>
                              ) : filteredCandidates.map((question) => {
                                const preview = questionPreview(question.id);
                                return (
                                  <DsButton
                                    key={question.id}
                                    variant="ghost"
                                    size="sm"
                                    disabled={Boolean(busyKey)}
                                    aria-label={t('questionBank.structure.addCandidate', {
                                      defaultValue: '添加 {{preview}}',
                                      preview,
                                    })}
                                    onClick={() => handleAddMember(group, question.id)}
                                    className="!h-auto w-full !justify-start !gap-1.5 !rounded-md !px-1.5 !py-1 text-left text-xs font-normal text-foreground"
                                  >
                                    <Plus size={11} className="flex-shrink-0 text-primary" aria-hidden="true" />
                                    <span className="min-w-0 truncate">{preview}</span>
                                  </DsButton>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="border-t border-border/40 pt-2">
                      <div className="mb-1 flex items-center gap-1 text-2xs font-medium text-muted-foreground">
                        <LinkSimple size={12} aria-hidden="true" />
                        {t('questionBank.structure.materials', { defaultValue: '共享材料' })}
                      </div>
                      {(structure.materials ?? []).length === 0 ? (
                        <p className="text-2xs text-muted-foreground">
                          {t('questionBank.structure.noMaterials', { defaultValue: '暂无可用材料' })}
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {structure.materials.map((material, index) => {
                            const linked = group.material_ids.includes(material.id);
                            const preview = materialPreview(material, index);
                            return (
                              <DsButton
                                key={material.id}
                                variant="ghost"
                                size="sm"
                                aria-pressed={linked}
                                aria-label={preview}
                                title={material.content}
                                disabled={!editable || Boolean(busyKey)}
                                onClick={() => handleToggleMaterial(group, material.id)}
                                className={cn(
                                  '!h-auto max-w-full !justify-start !gap-1 !rounded-md !px-2 !py-1 text-2xs font-normal transition-colors',
                                  linked
                                    ? 'border-primary/30 bg-primary/10 text-primary'
                                    : 'border-border/60 bg-muted/20 text-muted-foreground hover:bg-muted/40',
                                  !editable && 'cursor-default opacity-70',
                                )}
                              >
                                {linked
                                  ? <Check size={11} className="flex-shrink-0" aria-hidden="true" />
                                  : <Plus size={11} className="flex-shrink-0" aria-hidden="true" />}
                                <span className="min-w-0 truncate">{preview}</span>
                              </DsButton>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {editable && (
                      <div className="flex flex-wrap items-center justify-end gap-1 border-t border-border/40 pt-2">
                        <DsButton
                          variant="ghost"
                          size="sm"
                          disabled={Boolean(busyKey)}
                          onClick={() => {
                            setActionError(null);
                            setConfirm({
                              kind: 'dissolve_group',
                              groupId: group.id,
                              label: groupLabel,
                              count: group.question_ids.length,
                              version: group.version,
                            });
                          }}
                          className="lg:!h-8 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <ArrowsIn size={12} />
                          {t('questionBank.structure.dissolve', { defaultValue: '解散题组' })}
                        </DsButton>
                        <DsButton
                          variant="ghost"
                          size="sm"
                          disabled={Boolean(busyKey)}
                          onClick={() => {
                            setActionError(null);
                            setConfirm({
                              kind: 'delete_group',
                              groupId: group.id,
                              label: groupLabel,
                              count: group.question_ids.length,
                              version: group.version,
                            });
                          }}
                          className="lg:!h-8 text-xs text-destructive hover:bg-destructive/10"
                        >
                          <Trash size={12} />
                          {t('questionBank.structure.deleteGroup', { defaultValue: '删除题组及子题' })}
                        </DsButton>
                      </div>
                    )}
                  </div>
                </section>
              );
            })
          ) : null}

          {structure && unusedMaterials.length > 0 && (
            <section className="rounded-xl border border-border/50 bg-muted/10 px-3 py-2.5">
              <div className="mb-1 flex items-center gap-1 text-xs font-medium text-foreground">
                <BookOpen size={13} className="text-muted-foreground" aria-hidden="true" />
                {t('questionBank.structure.unusedMaterials', { defaultValue: '未使用材料' })}
              </div>
              <p className="mb-2 text-2xs text-muted-foreground">
                {t('questionBank.structure.unusedMaterialsHint', {
                  defaultValue: '没有被任何题组引用的材料可以删除。',
                })}
              </p>
              <ul className="space-y-1">
                {unusedMaterials.map((material, index) => {
                  const preview = materialPreview(material, index);
                  return (
                    <li key={material.id} className="flex items-center gap-2 rounded-md bg-background/50 px-2 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={material.content}>
                        {preview}
                      </span>
                      {editable && (
                        <DsButton
                          variant="ghost"
                          size="sm"
                          disabled={Boolean(busyKey)}
                          onClick={() => {
                            setActionError(null);
                            setConfirm({
                              kind: 'delete_material',
                              materialId: material.id,
                              preview,
                              version: material.version,
                            });
                          }}
                          className="lg:!h-7 flex-shrink-0 !px-1.5 text-xs text-destructive hover:bg-destructive/10"
                        >
                          <Trash size={11} />
                          {t('questionBank.structure.deleteMaterial', { defaultValue: '删除材料' })}
                        </DsButton>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </DsDialogBody>

        <DsDialogFooter>
          {confirmCopy && confirm ? (
            <div
              role="alertdialog"
              aria-label={confirmCopy.title}
              className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-warning/35 bg-warning/10 px-2.5 py-2"
            >
              <WarningCircle size={16} className="flex-shrink-0 text-warning" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-foreground">{confirmCopy.title}</p>
                <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
                  {confirmCopy.description}
                </p>
                {actionError && !actionError.conflict && (
                  <p role="alert" className="mt-1 break-all text-2xs text-destructive">
                    {t('questionBank.structure.actionFailed', {
                      defaultValue: '操作失败：{{message}}',
                      message: actionError.message,
                    })}
                  </p>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                <DsButton
                  variant="ghost"
                  size="sm"
                  disabled={Boolean(busyKey)}
                  onClick={() => {
                    setConfirm(null);
                    setActionError(null);
                  }}
                  className="lg:!h-8 text-muted-foreground"
                >
                  {t('questionBank.structure.cancel', { defaultValue: '取消' })}
                </DsButton>
                <DsButton
                  variant={confirmCopy.variant}
                  size="sm"
                  disabled={Boolean(busyKey)}
                  onClick={() => void handleConfirm()}
                  className="lg:!h-8"
                >
                  {busyKey && <CircleNotch size={12} className="animate-spin" aria-hidden="true" />}
                  {confirmCopy.confirmText}
                </DsButton>
              </div>
            </div>
          ) : (
            <>
              <DsButton
                variant="ghost"
                size="sm"
                disabled={loading || Boolean(busyKey)}
                onClick={() => void loadStructure()}
                className="lg:!h-8 text-muted-foreground"
              >
                <ArrowClockwise size={13} className={cn(loading && 'animate-spin')} />
                {t('questionBank.structure.reload', { defaultValue: '重新载入' })}
              </DsButton>
              <DsButton
                variant="secondary"
                size="sm"
                onClick={() => onOpenChange(false)}
                className="lg:!h-8"
              >
                {t('questionBank.structure.close', { defaultValue: '关闭' })}
              </DsButton>
            </>
          )}
        </DsDialogFooter>
      </DsDialog>
    </>
  );
}

export default QuestionStructureManager;
