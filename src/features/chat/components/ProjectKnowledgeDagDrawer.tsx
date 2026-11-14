import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowsClockwise,
  Check,
  FloppyDisk,
  GitBranch,
  Lock,
  PencilSimple,
  Play,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import {
  KnowledgeError,
  ProjectKnowledgeStore,
  ProjectKnowledgeDagStore,
  withStepsCheck,
  type KnowledgeNote,
  type KnowledgePlan,
  type KnowledgeTodo,
  type ProjectKnowledgeStoreLike,
  type TodoDispatchPayload,
} from '../utils/projectKnowledgeDag';

export {
  KnowledgeError,
  ProjectKnowledgeStore,
  ProjectKnowledgeDagStore,
  withStepsCheck,
  type KnowledgeNote,
  type KnowledgePlan,
  type KnowledgeTodo,
  type ProjectKnowledgeStoreLike,
  type TodoDispatchPayload,
};

// ============================================================================
// 类型与契约定义
// ============================================================================

export type TodoDagStatus = 'ready' | 'blocked' | 'completed';

export interface EnrichedDagTodo extends KnowledgeTodo {
  dagStatus: TodoDagStatus;
  unfinishedDependencyTitles: string[];
}

export interface ProjectKnowledgeDagDrawerProps {
  store?: ProjectKnowledgeStoreLike;
  data?: {
    plans: KnowledgePlan[];
    todos: KnowledgeTodo[];
    notes: KnowledgeNote[];
  };
  activePlanId?: string | null;
  isOpen?: boolean;
  onClose?: () => void;
  onToggleTodo?: (todo: KnowledgeTodo, completed: boolean) => void;
  onDispatchTodo?: (payload: TodoDispatchPayload) => void;
  onSaveNote?: (note: KnowledgeNote, expected?: string) => void;
  className?: string;
}

function extractPlanHeading(body: string, fallbackId: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return fallbackId;
  return firstLine.replace(/^#+\s*/, '').trim() || fallbackId;
}

// ============================================================================
// 组件实现
// ============================================================================

export const ProjectKnowledgeDagDrawer: React.FC<ProjectKnowledgeDagDrawerProps> = ({
  store,
  data,
  activePlanId,
  isOpen = true,
  onClose,
  onToggleTodo,
  onDispatchTodo,
  onSaveNote,
  className,
}) => {
  const [plans, setPlans] = useState<KnowledgePlan[]>(() =>
    store ? store.listPlans() : (data?.plans ?? []),
  );
  const [todos, setTodos] = useState<KnowledgeTodo[]>(() =>
    store ? store.listTodos() : (data?.todos ?? []),
  );
  const [notes, setNotes] = useState<KnowledgeNote[]>(() =>
    store ? store.listNotes() : (data?.notes ?? []),
  );

  const [selectedPlanId, setSelectedPlanId] = useState<string | 'all'>(() => {
    if (activePlanId) return activePlanId;
    const initialPlans = store ? store.listPlans() : (data?.plans ?? []);
    return initialPlans.length > 0 ? initialPlans[0].id : 'all';
  });

  // 笔记乐观锁编辑状态
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingDraftBody, setEditingDraftBody] = useState<string>('');
  const [editingExpectedBody, setEditingExpectedBody] = useState<string>('');
  const [noteConflictError, setNoteConflictError] = useState<string | null>(null);
  const [noteSaveSuccess, setNoteSaveSuccess] = useState<string | null>(null);

  const syncFromStore = useCallback(() => {
    if (!store) return;
    setPlans(store.listPlans());
    setTodos(store.listTodos());
    setNotes(store.listNotes());
  }, [store]);

  // 当外部 data 变化时同步
  useEffect(() => {
    if (!store && data) {
      setPlans(data.plans);
      setTodos(data.todos);
      setNotes(data.notes);
    }
  }, [store, data]);

  // 当传入 store 实例或抽屉重新打开时，自动同步并订阅外部 store 变更刷新
  useEffect(() => {
    if (!store) return;
    syncFromStore();
    if (typeof store.subscribe === 'function') {
      return store.subscribe(() => {
        syncFromStore();
      });
    }
    return undefined;
  }, [store, isOpen, syncFromStore]);

  // 当外部 activePlanId prop 变化时同步更新 selectedPlanId
  useEffect(() => {
    if (activePlanId !== undefined) {
      if (activePlanId) {
        setSelectedPlanId(activePlanId);
      } else {
        const availablePlans = store ? store.listPlans() : (data?.plans ?? []);
        setSelectedPlanId(availablePlans.length > 0 ? availablePlans[0].id : 'all');
      }
    }
  }, [activePlanId, store, data?.plans]);

  const currentPlan = useMemo(() => {
    if (selectedPlanId === 'all') return plans[0] ?? null;
    return plans.find((p) => p.id === selectedPlanId) ?? plans[0] ?? null;
  }, [plans, selectedPlanId]);

  const todoMap = useMemo(() => {
    const map = new Map<string, KnowledgeTodo>();
    for (const todo of todos) {
      map.set(todo.id, todo);
    }
    return map;
  }, [todos]);

  // 过滤当前计划下的 Todo 并计算 DAG 拓扑状态（Ready / Blocked / Completed）
  const enrichedTodos = useMemo<EnrichedDagTodo[]>(() => {
    const scoped =
      selectedPlanId === 'all'
        ? todos
        : todos.filter((t) => t.planId === selectedPlanId || t.planId === null);

    return scoped.map((todo) => {
      const unfinishedDeps = todo.dependsOn
        .map((depId) => todoMap.get(depId))
        .filter((dep): dep is KnowledgeTodo => Boolean(dep && !dep.completed));

      const unfinishedDependencyTitles = unfinishedDeps.map((dep) => dep.body);
      let dagStatus: TodoDagStatus = 'ready';
      if (todo.completed) {
        dagStatus = 'completed';
      } else if (unfinishedDependencyTitles.length > 0) {
        dagStatus = 'blocked';
      } else {
        dagStatus = 'ready';
      }

      return {
        ...todo,
        dagStatus,
        unfinishedDependencyTitles,
      };
    });
  }, [todos, selectedPlanId, todoMap]);

  // DAG 进度与 Plan 完成度统计
  const dagSummary = useMemo(() => {
    const totalTodos = enrichedTodos.length;
    const completedTodos = enrichedTodos.filter((t) => t.dagStatus === 'completed').length;
    const readyTodos = enrichedTodos.filter((t) => t.dagStatus === 'ready').length;
    const blockedTodos = enrichedTodos.filter((t) => t.dagStatus === 'blocked').length;

    const planDone = currentPlan?.progress.done ?? 0;
    const planTotal = currentPlan?.progress.total ?? 0;

    const effectiveDone = totalTodos > 0 ? completedTodos : planDone;
    const effectiveTotal = totalTodos > 0 ? totalTodos : planTotal;
    const completionPercent =
      effectiveTotal > 0 ? Math.round((effectiveDone / effectiveTotal) * 100) : 0;

    return {
      totalTodos,
      completedTodos,
      readyTodos,
      blockedTodos,
      planDone,
      planTotal,
      effectiveDone,
      effectiveTotal,
      completionPercent,
    };
  }, [enrichedTodos, currentPlan]);

  // 勾选或取消勾选 Todo（自动解锁或重新锁定下游依赖任务）
  const handleCompleteOrToggleTodo = useCallback(
    (todo: EnrichedDagTodo) => {
      if (todo.dagStatus === 'blocked') return;

      const nextCompleted = !todo.completed;
      if (store) {
        const updated = store.saveTodo({
          id: todo.id,
          completed: nextCompleted,
        });
        syncFromStore();
        onToggleTodo?.(updated, updated.completed);
      } else {
        const updated: KnowledgeTodo = {
          ...todo,
          completed: nextCompleted,
        };
        setTodos((prev) =>
          prev.map((item) => (item.id === todo.id ? updated : item)),
        );
        onToggleTodo?.(updated, updated.completed);
      }
    },
    [store, syncFromStore, onToggleTodo],
  );

  const handleDispatchReadyTodo = useCallback(
    (todo: EnrichedDagTodo) => {
      if (todo.dagStatus !== 'ready') return;
      if (store) {
        const payload = store.buildTodoDispatchPayload(todo.id, 'current_session');
        onDispatchTodo?.(payload);
      } else {
        onDispatchTodo?.({
          todoId: todo.id,
          target: 'current_session',
          planId: todo.planId,
          prompt: currentPlan ? `${todo.body}\n\n${currentPlan.body}` : todo.body,
        });
      }
    },
    [store, currentPlan, onDispatchTodo],
  );

  // 开启笔记编辑，记录乐观锁快照 expectedBody
  const handleStartEditNote = useCallback((note: KnowledgeNote) => {
    setEditingNoteId(note.id);
    setEditingDraftBody(note.body);
    setEditingExpectedBody(note.body);
    setNoteConflictError(null);
    setNoteSaveSuccess(null);
  }, []);

  const handleCancelEditNote = useCallback(() => {
    setEditingNoteId(null);
    setEditingDraftBody('');
    setEditingExpectedBody('');
    setNoteConflictError(null);
  }, []);

  // 保存笔记（执行乐观锁版本校验）
  const handleSaveEditedNote = useCallback(() => {
    if (!editingNoteId) return;
    const trimmed = editingDraftBody.trim();
    if (!trimmed) {
      setNoteConflictError('笔记正文不能为空');
      return;
    }

    try {
      if (store) {
        const saved = store.saveNote({
          id: editingNoteId,
          body: trimmed,
          expected: editingExpectedBody,
        });
        syncFromStore();
        onSaveNote?.(saved, editingExpectedBody);
      } else {
        const latestNote = (data?.notes ?? notes).find((n) => n.id === editingNoteId);
        if (latestNote && latestNote.body !== editingExpectedBody) {
          throw new KnowledgeError(
            'KNOWLEDGE_EXPECTED_CONFLICT',
            '正文已变更，请重新读取后再保存',
          );
        }
        const saved: KnowledgeNote = {
          id: editingNoteId,
          body: trimmed,
          sessionId: latestNote?.sessionId ?? null,
        };
        setNotes((prev) =>
          prev.map((item) => (item.id === editingNoteId ? saved : item)),
        );
        onSaveNote?.(saved, editingExpectedBody);
      }
      setEditingNoteId(null);
      setNoteConflictError(null);
      setNoteSaveSuccess('笔记已保存');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : '正文已变更，请重新读取后再保存';
      setNoteConflictError(message);
    }
  }, [
    editingNoteId,
    editingDraftBody,
    editingExpectedBody,
    store,
    data?.notes,
    notes,
    syncFromStore,
    onSaveNote,
  ]);

  // 冲突后重新读取最新笔记正文并更新乐观锁基线
  const handleRefreshConflictedNote = useCallback(() => {
    if (!editingNoteId) return;
    const latestList = store ? store.listNotes() : (data?.notes ?? notes);
    const latest = latestList.find((n) => n.id === editingNoteId);
    if (latest) {
      setNotes(latestList);
      setEditingDraftBody(latest.body);
      setEditingExpectedBody(latest.body);
      setNoteConflictError(null);
    }
  }, [editingNoteId, store, data?.notes, notes]);

  if (!isOpen) return null;

  return (
    <aside
      aria-label="项目知识与学习计划拓扑抽屉"
      data-testid="project-knowledge-dag-drawer"
      className={cn(
        'w-full max-w-md rounded-xl border border-border/35 bg-card text-card-foreground shadow-lg flex flex-col overflow-hidden',
        className,
      )}
    >
      {/* 抽屉顶栏 */}
      <header className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border/35 bg-muted/20">
        <div className="flex items-center gap-2">
          <GitBranch size={16} className="text-primary shrink-0" />
          <h2 className="text-sm font-semibold text-foreground">
            学习计划与任务拓扑
          </h2>
        </div>

        <div className="flex items-center gap-2">
          <span
            data-testid="dag-completion-badge"
            className="text-xs font-mono tabular-nums px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium"
          >
            {dagSummary.effectiveDone}/{dagSummary.effectiveTotal} ({dagSummary.completionPercent}%)
          </span>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭计划抽屉"
              className="p-1 rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </header>

      {/* 当前学习计划（Plan）进度区 */}
      <section className="p-4 border-b border-border/35 bg-muted/10 flex flex-col gap-3">
        {plans.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {plans.map((plan) => (
              <button
                key={plan.id}
                type="button"
                onClick={() => setSelectedPlanId(plan.id)}
                className={cn(
                  'px-2.5 py-1 text-xs rounded-md border border-border/35 transition-colors',
                  selectedPlanId === plan.id
                    ? 'bg-primary text-primary-foreground border-primary font-medium'
                    : 'bg-background text-muted-foreground hover:text-foreground',
                )}
              >
                {extractPlanHeading(plan.body, plan.id)}
              </button>
            ))}
          </div>
        )}

        {currentPlan ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground truncate">
                {extractPlanHeading(currentPlan.body, currentPlan.id)}
              </span>
              <span className="text-xs font-mono tabular-nums text-muted-foreground shrink-0">
                步骤 {currentPlan.progress.done}/{currentPlan.progress.total}
              </span>
            </div>

            {/* 完成度进度条 */}
            <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
              <div
                data-testid="dag-plan-progress-bar"
                className="h-full bg-success transition-all duration-300"
                style={{ width: `${dagSummary.completionPercent}%` }}
              />
            </div>

            {/* 拓扑状态概览计数器 */}
            <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-0.5">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-success" />
                <span>可执行就绪</span>
                <strong
                  data-testid="dag-ready-count"
                  className="font-mono tabular-nums text-foreground"
                >
                  {dagSummary.readyTodos}
                </strong>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-warning" />
                <span>前置阻塞</span>
                <strong
                  data-testid="dag-blocked-count"
                  className="font-mono tabular-nums text-foreground"
                >
                  {dagSummary.blockedTodos}
                </strong>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                <span>已完成</span>
                <strong
                  data-testid="dag-completed-count"
                  className="font-mono tabular-nums text-foreground"
                >
                  {dagSummary.completedTodos}
                </strong>
              </span>
            </div>

            {currentPlan.warning && (
              <div className="text-[11px] text-warning bg-warning/10 px-2.5 py-1.5 rounded border border-warning/25">
                {currentPlan.warning}
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">当前暂无关联学习计划</p>
        )}
      </section>

      {/* DAG 任务拓扑列表区 */}
      <section className="p-4 border-b border-border/35 flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-foreground">
            任务依赖拓扑（DAG）
          </h3>
          <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
            共 {enrichedTodos.length} 项
          </span>
        </div>

        <div className="flex flex-col gap-2">
          {enrichedTodos.map((todo) => {
            const isReady = todo.dagStatus === 'ready';
            const isBlocked = todo.dagStatus === 'blocked';
            const isCompleted = todo.dagStatus === 'completed';

            return (
              <div
                key={todo.id}
                data-testid={`dag-todo-item-${todo.id}`}
                data-dag-status={todo.dagStatus}
                className={cn(
                  'rounded-lg border p-3 flex flex-col gap-2 transition-colors',
                  isReady &&
                    'border-success/40 bg-success/5 text-foreground',
                  isBlocked &&
                    'border-border/35 bg-muted/20 text-muted-foreground',
                  isCompleted &&
                    'border-border/35 bg-background/60 text-muted-foreground',
                )}
              >
                <div className="flex items-start justify-between gap-2.5">
                  <div className="flex items-start gap-2.5 min-w-0 flex-1">
                    {/* 一键勾选完成按钮 */}
                    <button
                      type="button"
                      disabled={isBlocked}
                      aria-label={`勾选任务：${todo.body}`}
                      onClick={() => handleCompleteOrToggleTodo(todo)}
                      className={cn(
                        'mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors',
                        isCompleted &&
                          'bg-success border-success text-primary-foreground',
                        isReady &&
                          'border-success/60 bg-background hover:bg-success/15',
                        isBlocked &&
                          'border-border/35 bg-muted cursor-not-allowed opacity-60',
                      )}
                    >
                      {isCompleted && <Check size={12} weight="bold" />}
                      {isBlocked && <Lock size={10} />}
                    </button>

                    <div className="flex flex-col gap-1 min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {/* 6px 状态点：Ready 高亮绿点 */}
                        <span
                          data-testid={`dag-todo-dot-${todo.id}`}
                          className={cn(
                            'w-1.5 h-1.5 rounded-full shrink-0',
                            isReady && 'bg-success',
                            isBlocked && 'bg-warning',
                            isCompleted && 'bg-muted-foreground/50',
                          )}
                        />
                        <span
                          className={cn(
                            'text-xs font-medium leading-snug',
                            isCompleted && 'line-through text-muted-foreground',
                          )}
                        >
                          {todo.body}
                        </span>
                      </div>

                      {/* 状态徽标：就绪可执行 / 等待前置：<前置任务名> */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        {isReady && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-success/15 text-success">
                            就绪可执行
                          </span>
                        )}
                        {isBlocked && (
                          <span
                            data-testid={`dag-blocked-badge-${todo.id}`}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded bg-warning/15 text-warning border border-warning/25"
                          >
                            等待前置：{todo.unfinishedDependencyTitles.join('、')}
                          </span>
                        )}
                        {isCompleted && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-muted text-muted-foreground">
                            已完成
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Ready 项可一键派发 */}
                  {isReady && onDispatchTodo && (
                    <button
                      type="button"
                      onClick={() => handleDispatchReadyTodo(todo)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-success/30 bg-success/10 text-success hover:bg-success/20 shrink-0"
                    >
                      <Play size={12} />
                      <span>派发</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 底部关联课堂笔记（Notes）与乐观锁版本校验编辑 */}
      <section className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-foreground">
            关联课堂笔记（乐观锁保护）
          </h3>
          <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
            {notes.length} 条
          </span>
        </div>

        {noteSaveSuccess && (
          <div
            role="status"
            className="text-xs px-3 py-1.5 rounded bg-success/10 text-success border border-success/25"
          >
            {noteSaveSuccess}
          </div>
        )}

        <div className="flex flex-col gap-2.5">
          {notes.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">暂无关联课堂笔记</p>
          ) : (
            notes.map((note) => {
              const isEditing = editingNoteId === note.id;

              return (
                <div
                  key={note.id}
                  data-testid={`dag-note-card-${note.id}`}
                  className="rounded-lg border border-border/35 bg-background p-3 flex flex-col gap-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
                      笔记 #{note.id}
                    </span>
                    {!isEditing && (
                      <button
                        type="button"
                        onClick={() => handleStartEditNote(note)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-border/35 hover:bg-muted/60 text-foreground"
                      >
                        <PencilSimple size={12} />
                        <span>编辑笔记</span>
                      </button>
                    )}
                  </div>

                  {isEditing ? (
                    <div className="flex flex-col gap-2">
                      <textarea
                        rows={3}
                        aria-label={`编辑笔记 ${note.id}`}
                        value={editingDraftBody}
                        onChange={(e) => setEditingDraftBody(e.target.value)}
                        className="w-full px-2.5 py-2 text-xs rounded border border-border/35 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      />

                      {noteConflictError && (
                        <div
                          role="alert"
                          data-testid="dag-note-conflict-alert"
                          className="p-2.5 rounded border border-destructive/40 bg-destructive/10 text-destructive text-xs flex flex-col gap-2"
                        >
                          <div className="flex items-center gap-1.5 font-medium">
                            <WarningCircle size={14} className="shrink-0" />
                            <span>版本冲突：{noteConflictError}</span>
                          </div>
                          <button
                            type="button"
                            onClick={handleRefreshConflictedNote}
                            className="inline-flex items-center gap-1 self-start px-2 py-1 text-[11px] rounded border border-destructive/40 bg-background text-foreground hover:bg-muted/50"
                          >
                            <ArrowsClockwise size={12} />
                            <span>重新读取最新内容</span>
                          </button>
                        </div>
                      )}

                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={handleCancelEditNote}
                          className="px-2.5 py-1 text-xs rounded border border-border/35 bg-background hover:bg-muted/60"
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          onClick={handleSaveEditedNote}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-primary text-primary-foreground"
                        >
                          <FloppyDisk size={12} />
                          <span>保存修改</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-foreground/90 leading-relaxed whitespace-pre-wrap">
                      {note.body}
                    </p>
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>
    </aside>
  );
};

export default ProjectKnowledgeDagDrawer;
