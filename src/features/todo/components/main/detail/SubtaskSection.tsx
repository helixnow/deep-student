/**
 * SubtaskSection — 详情面板子任务区
 *
 * - 分区标题带 SVG 完成度圆环（done/total）；勾选后圆环 + 计数联动弹跳（级联进度反馈）
 * - 子任务拖拽排序：把手触发（不与行点击冲突），拖拽中投影抬升；
 *   持久化走 store.reorderSubtasks（内部全量精确覆盖 + 乐观重排 +
 *   失败回滚 + 静默校准 + 错误通知），本地只维护拖拽期间的实时顺序
 * - 子任务增删经 framer-motion 高度展开/收合动效（AI 拆解结果同路径渐入）
 * - 勾选完成复用列表的 todo-check-pop 弹性动效
 * - Enter 连续添加保持输入框焦点；「转为独立任务」内联操作（parentId 置空）
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AnimatePresence,
  Reorder,
  motion,
  useDragControls,
  useReducedMotion,
} from 'framer-motion';
import {
  ArrowLineUp,
  CaretRight,
  Check,
  CheckCircle,
  CircleNotch,
  DotsSixVertical,
  Plus,
  Sparkle,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/shad/Input';
import { springSoft, tweenFast } from '@/styles/motion-springs';
import { useTodoStore } from '../../../stores/useTodoStore';
import { aiBreakdownTodo } from '../../../api';
import type { TodoItem } from '../../../types';
import { InlineReveal } from './InlineReveal';
import { ProgressRing } from './ProgressRing';

/** 勾选弹性动效时长（todo-check-pop 为 260ms，留缓冲后复位状态） */
const CHECK_POP_MS = 300;

/** 内联错误提示自动收起时长 */
const ERROR_DISMISS_MS = 5000;

/* ------------------------------------------------------------------ */

const SubtaskRow: React.FC<{
  sub: TodoItem;
  popId: string | null;
  reducedMotion: boolean;
  onToggle: (sub: TodoItem) => void;
  onOpen: (id: string) => void;
  onPromote: (id: string) => void;
  onDelete: (id: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}> = ({ sub, popId, reducedMotion, onToggle, onOpen, onPromote, onDelete, onDragStart, onDragEnd }) => {
  const { t } = useTranslation(['todo']);
  const dragControls = useDragControls();

  return (
    <Reorder.Item
      as="div"
      value={sub.id}
      dragListener={false}
      dragControls={dragControls}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      layout={reducedMotion ? undefined : 'position'}
      initial={reducedMotion ? false : { opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={reducedMotion ? undefined : { opacity: 0, height: 0 }}
      transition={reducedMotion ? { duration: 0 } : { ...springSoft, opacity: tweenFast }}
      whileDrag={{
        scale: reducedMotion ? 1 : 1.02,
        boxShadow: '0 4px 16px rgba(0,0,0,0.14)',
        zIndex: 30,
      }}
      className="relative overflow-visible rounded-[var(--radius-shell-control)] bg-transparent"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(sub.id)}
        onKeyDown={(e) => {
          // role="button" 约定：Enter 与 Space 都应激活（Space 不再滚动页面）
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen(sub.id);
          }
        }}
        title={t('todo:subtasks.openDetail')}
        className="group/subtask flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-shell-control)] px-1 py-1 [@media(pointer:coarse)]:min-h-11 transition-colors duration-150 hover:bg-[color:var(--interactive-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:hsl(var(--primary))]/50"
      >
        {/* 拖拽把手：hover 常显、触屏淡显；不与行点击冲突 */}
        <span
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            dragControls.start(e);
          }}
          onClick={(e) => e.stopPropagation()}
          aria-hidden="true"
          // 触屏：视觉 14×16 太小，实际盒撑到 44×44；负 margin 抵消宽度增量保持布局不变
          className="flex h-4 w-3.5 flex-shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground/0 transition-colors duration-150 active:cursor-grabbing group-hover/subtask:text-muted-foreground/60 [@media(pointer:coarse)]:text-muted-foreground/40 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:-mx-[15px]"
        >
          <DotsSixVertical size={13} weight="bold" />
        </span>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle(sub);
          }}
          // 触屏：内容仅 16px，p-3.5（14×2）才够 44px 命中；负 margin 保持布局不变
          className="flex-shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))] [@media(pointer:coarse)]:p-3.5 [@media(pointer:coarse)]:-m-3.5"
          aria-label={
            sub.status === 'completed'
              ? t('todo:actions.markPending')
              : t('todo:actions.markCompleted')
          }
        >
          {sub.status === 'completed' ? (
            <CheckCircle
              size={16}
              weight="fill"
              className={cn(
                'text-[color:hsl(var(--success))]',
                popId === sub.id && 'todo-check-pop',
              )}
            />
          ) : (
            <span className="group/subcheck flex h-4 w-4 items-center justify-center rounded-full border-[1.5px] border-[color:var(--border-default)] transition-colors duration-150 hover:border-[color:hsl(var(--primary))]">
              <Check
                size={10}
                className="text-[color:hsl(var(--primary))] opacity-0 transition-opacity duration-150 group-hover/subcheck:opacity-40"
              />
            </span>
          )}
        </button>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-ui transition-colors duration-150',
            sub.status === 'completed' && 'text-muted-foreground line-through',
          )}
        >
          {sub.title}
        </span>
        <CaretRight
          size={12}
          className="flex-shrink-0 text-muted-foreground/0 transition-colors group-hover/subtask:text-muted-foreground/60"
        />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPromote(sub.id);
          }}
          aria-label={t('todo:subtasks.promote')}
          title={t('todo:subtasks.promote')}
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/subtask:opacity-100 [@media(pointer:coarse)]:opacity-60 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:-my-3"
        >
          <ArrowLineUp size={12} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(sub.id);
          }}
          aria-label={t('todo:actions.deleteItem')}
          title={t('todo:actions.deleteItem')}
          // 触屏无 hover：常显淡色并扩大命中（否则子任务删除不可发现/难点中）
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-[color:hsl(var(--destructive))] group-hover/subtask:opacity-100 [@media(pointer:coarse)]:opacity-60 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:-my-3 [@media(pointer:coarse)]:-mr-3"
        >
          <X size={12} />
        </button>
      </div>
    </Reorder.Item>
  );
};

/* ------------------------------------------------------------------ */

export const SubtaskSection: React.FC<{
  item: TodoItem;
  subtasks: TodoItem[];
}> = ({ item, subtasks }) => {
  const { t } = useTranslation(['todo']);
  const prefersReducedMotion = useReducedMotion() ?? false;
  const toggleItem = useTodoStore((s) => s.toggleItem);
  const deleteItem = useTodoStore((s) => s.deleteItem);
  const selectItem = useTodoStore((s) => s.selectItem);
  const createItem = useTodoStore((s) => s.createItem);
  const updateItem = useTodoStore((s) => s.updateItem);
  const reorderSubtasks = useTodoStore((s) => s.reorderSubtasks);
  const reloadCurrentView = useTodoStore((s) => s.reloadCurrentView);

  const [draft, setDraft] = useState('');
  const [aiBreaking, setAiBreaking] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [popId, setPopId] = useState<string | null>(null);
  const popTimerRef = useRef<number | null>(null);
  const errorTimerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (popTimerRef.current !== null) window.clearTimeout(popTimerRef.current);
      if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
    };
  }, []);

  const showInlineError = useCallback((message: string) => {
    if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
    setInlineError(message);
    errorTimerRef.current = window.setTimeout(() => {
      errorTimerRef.current = null;
      setInlineError(null);
    }, ERROR_DISMISS_MS);
  }, []);

  // ===== 本地排序（仅拖拽期间的实时顺序；持久化/回滚/校准由 store 统一处理） =====
  const propIds = useMemo(() => subtasks.map((s) => s.id), [subtasks]);
  const [orderIds, setOrderIds] = useState<string[]>(propIds);
  // dragEnd 时读最新顺序（onReorder 的 setState 与 pointerup 同帧竞态防御）
  const orderIdsRef = useRef(orderIds);
  orderIdsRef.current = orderIds;
  // 拖拽进行中不采纳外部顺序（否则静默校准落地会让列表在指针下跳动）
  const draggingRef = useRef(false);

  // store 顺序是唯一权威（reorderSubtasks 乐观重排即时生效、失败回滚、
  // 静默校准带回服务端真序）：非拖拽期间本地顺序始终跟随 props
  useEffect(() => {
    if (draggingRef.current) return;
    setOrderIds((prev) =>
      prev.length === propIds.length && prev.every((id, i) => id === propIds[i])
        ? prev
        : propIds,
    );
  }, [propIds]);

  const byId = useMemo(() => new Map(subtasks.map((s) => [s.id, s])), [subtasks]);
  const orderedSubtasks = useMemo(
    () => orderIds.map((id) => byId.get(id)).filter((s): s is TodoItem => Boolean(s)),
    [orderIds, byId],
  );

  // 连续快速拖拽时串行提交，避免 store 内「拉全量 + 精确覆盖」两次在途交错
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());

  const handleDragStart = useCallback(() => {
    draggingRef.current = true;
  }, []);

  const handleDragEnd = useCallback(() => {
    draggingRef.current = false;
    const next = orderIdsRef.current;
    // 原地放下（顺序未变）不发起后端写
    const current = useTodoStore
      .getState()
      .items.filter((i) => i.parentId === item.id)
      .map((i) => i.id);
    if (next.length === current.length && next.every((id, i) => id === current[i])) return;
    persistChainRef.current = persistChainRef.current.then(() =>
      // 失败回滚 + 错误通知由 store 处理；items 回滚经上面的 effect 还原本地顺序
      reorderSubtasks(item.id, next).catch(() => undefined),
    );
  }, [item.id, reorderSubtasks]);

  const doneCount = orderedSubtasks.filter((s) => s.status === 'completed').length;
  const totalCount = orderedSubtasks.length;

  // ===== 级联进度反馈：完成数上升时圆环 + 计数弹跳 =====
  const prevDoneRef = useRef(doneCount);
  const [progressPulse, setProgressPulse] = useState(0);
  useEffect(() => {
    if (doneCount > prevDoneRef.current) {
      setProgressPulse((n) => n + 1);
    }
    prevDoneRef.current = doneCount;
  }, [doneCount]);

  const handleToggle = useCallback(
    (sub: TodoItem) => {
      if (sub.status !== 'completed') {
        if (popTimerRef.current !== null) window.clearTimeout(popTimerRef.current);
        setPopId(sub.id);
        popTimerRef.current = window.setTimeout(() => {
          popTimerRef.current = null;
          setPopId(null);
        }, CHECK_POP_MS);
      }
      void toggleItem(sub.id);
    },
    [toggleItem],
  );

  const handleAdd = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setDraft('');
    try {
      await createItem({ todoListId: item.todoListId, title: trimmed, parentId: item.id });
    } catch {
      // 失败提示由 store 统一处理
    }
    // Enter 连续添加：提交后焦点留在输入框
    inputRef.current?.focus();
  }, [draft, createItem, item.todoListId, item.id]);

  /** 转为独立任务：parentId 置空（后端 Some("") 语义 = 清空为 NULL） */
  const handlePromote = useCallback(
    (subId: string) => {
      void updateItem({ id: subId, parentId: '' });
    },
    [updateItem],
  );

  const handleAiBreakdown = useCallback(async () => {
    if (aiBreaking) return;
    setAiBreaking(true);
    setInlineError(null);
    try {
      await aiBreakdownTodo(item.id);
      // 新子任务经 reload 进入 store，行高度展开动画渐入
      await reloadCurrentView();
    } catch (err) {
      showInlineError(String(err));
    } finally {
      setAiBreaking(false);
    }
  }, [aiBreaking, item.id, reloadCurrentView, showInlineError]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {totalCount > 0 && (
            <motion.span
              key={progressPulse}
              initial={false}
              animate={
                prefersReducedMotion || progressPulse === 0
                  ? { scale: 1 }
                  : { scale: [1, 1.35, 1] }
              }
              transition={{ duration: 0.35, ease: [0.34, 1.56, 0.64, 1] }}
              className="flex flex-shrink-0"
            >
              <ProgressRing done={doneCount} total={totalCount} />
            </motion.span>
          )}
          {t('todo:subtasks.title')}
          {totalCount > 0 && (
            <span
              className="font-normal normal-case tabular-nums text-muted-foreground/70"
              aria-label={t('todo:detail.subtaskProgress', { done: doneCount, total: totalCount })}
            >
              {doneCount}/{totalCount}
            </span>
          )}
        </span>
        <button
          onClick={() => void handleAiBreakdown()}
          disabled={aiBreaking}
          className={cn(
            'flex items-center gap-1 rounded-[var(--radius-shell-control)] px-1.5 py-0.5 text-xs transition-colors duration-150 motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-2.5',
            aiBreaking
              ? 'cursor-default text-muted-foreground/50'
              : 'text-muted-foreground hover:bg-[color:var(--interactive-hover)] hover:text-foreground',
          )}
          title={t('todo:subtasks.aiBreakdownHint')}
        >
          {aiBreaking ? <CircleNotch size={12} className="animate-spin" /> : <Sparkle size={12} />}
          {aiBreaking ? t('todo:subtasks.aiBreaking') : t('todo:subtasks.aiBreakdown')}
        </button>
      </div>

      <InlineReveal open={inlineError !== null}>
        <p className="px-1 pb-1 text-xs text-[color:hsl(var(--destructive))]" role="alert">
          {inlineError}
        </p>
      </InlineReveal>

      <Reorder.Group
        axis="y"
        values={orderIds}
        onReorder={setOrderIds}
        as="div"
        className="relative"
      >
        <AnimatePresence initial={false}>
          {orderedSubtasks.map((sub) => (
            <SubtaskRow
              key={sub.id}
              sub={sub}
              popId={popId}
              reducedMotion={prefersReducedMotion}
              onToggle={handleToggle}
              onOpen={selectItem}
              onPromote={handlePromote}
              onDelete={(id) => void deleteItem(id)}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            />
          ))}
        </AnimatePresence>
      </Reorder.Group>

      <div className="flex items-center gap-2 px-1">
        <Plus size={14} className="flex-shrink-0 text-muted-foreground/60" />
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void handleAdd();
              return;
            }
            if (e.key === 'Escape' && draft) {
              e.preventDefault();
              e.stopPropagation();
              setDraft('');
            }
          }}
          placeholder={t('todo:subtasks.addPlaceholder')}
          className="h-7 flex-1 border-0 bg-transparent px-0 text-ui focus-visible:ring-0 placeholder:text-muted-foreground/50 [@media(pointer:coarse)]:h-11"
        />
      </div>
    </div>
  );
};

export default SubtaskSection;
