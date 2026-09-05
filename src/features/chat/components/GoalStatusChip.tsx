/**
 * Goal 模式（P0）— 顶栏目标状态 Chip
 *
 * 显示当前会话的持久目标状态（store.goal 由 goal_updated 会话事件 /
 * fetchGoal 驱动），点击展开操作菜单：暂停/继续、编辑目标、清除目标。
 * goal 为 null 时不渲染。
 *
 * 挂载点：桌面端 App.tsx chat-v2 顶栏标题旁；移动端 useChatPageLayout
 * rightActions（compact 紧凑版：图标 + 状态点）。
 */

import React, { useCallback, useState } from 'react';
import { useStore, type StoreApi } from 'zustand';
import {
  CheckCircle,
  CircleNotch,
  Coins,
  HourglassMedium,
  Pause,
  PencilSimple,
  Play,
  Question,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuLabel,
  AppMenuSeparator,
  AppMenuTrigger,
} from '@/components/ui/app-menu/AppMenu';
import {
  DsAlertDialog,
  DsDialog,
  DsDialogBody,
  DsDialogFooter,
  DsDialogHeader,
  DsDialogTitle,
} from '@/components/ui/DsDialog';
import { DsButton } from '@/components/ui/DsButton';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Input } from '@/components/ui/shad/Input';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/config/zIndex';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { sessionManager } from '../core/session/sessionManager';
import type { ChatStore } from '../core/types';
import type { GoalStatus } from '../core/types';

// ============================================================================
// 状态展示元数据
// ============================================================================

interface GoalStatusMeta {
  /** 短文本标签 */
  label: string;
  /** 图标着色（Tailwind 语义色） */
  iconClassName: string;
  /** 状态点着色（compact 模式） */
  dotClassName: string;
}

const GOAL_STATUS_META: Record<GoalStatus, GoalStatusMeta> = {
  active: {
    label: '目标进行中',
    iconClassName: 'text-primary',
    dotClassName: 'bg-primary',
  },
  waiting_user: {
    label: '等待你的回答',
    iconClassName: 'text-warning',
    dotClassName: 'bg-warning',
  },
  paused: {
    label: '目标已暂停',
    iconClassName: 'text-muted-foreground',
    dotClassName: 'bg-muted-foreground',
  },
  blocked: {
    label: '目标受阻',
    iconClassName: 'text-destructive',
    dotClassName: 'bg-destructive',
  },
  budget_limited: {
    label: '已达预算上限',
    iconClassName: 'text-warning',
    dotClassName: 'bg-warning',
  },
  usage_limited: {
    label: '已达用量上限',
    iconClassName: 'text-warning',
    dotClassName: 'bg-warning',
  },
  complete: {
    label: '目标已完成',
    iconClassName: 'text-success',
    dotClassName: 'bg-success',
  },
};

function renderStatusIcon(status: GoalStatus, size: number): React.ReactNode {
  const className = GOAL_STATUS_META[status].iconClassName;
  switch (status) {
    case 'active':
      return <CircleNotch size={size} weight="bold" className={cn('animate-spin', className)} />;
    case 'waiting_user':
      return <Question size={size} weight="bold" className={className} />;
    case 'paused':
      return <Pause size={size} weight="bold" className={className} />;
    case 'blocked':
      return <WarningCircle size={size} weight="bold" className={className} />;
    case 'budget_limited':
      return <Coins size={size} weight="bold" className={className} />;
    case 'usage_limited':
      return <HourglassMedium size={size} weight="bold" className={className} />;
    case 'complete':
      return <CheckCircle size={size} weight="bold" className={className} />;
  }
}

/** token 计数千分位展示 */
function formatTokenCount(value: number): string {
  return value.toLocaleString();
}

// ============================================================================
// 组件
// ============================================================================

export interface GoalStatusChipProps {
  sessionId: string;
  /** 紧凑模式（移动端顶栏）：图标 + 状态点，点击同样展开菜单 */
  compact?: boolean;
}

/**
 * 外层壳：负责从 sessionManager 取当前会话 store。
 * sessionManager.get 非响应式——store 尚未创建时渲染 null；会话切换/销毁
 * 会触发父级（App.tsx 顶栏标题同步链 / useChatPageLayout deps）重渲染，
 * 届时重新取 store。store 身份变化时内层经 key 重挂载，hooks 安全。
 */
export function GoalStatusChip({ sessionId, compact }: GoalStatusChipProps) {
  const store = sessionManager.get(sessionId);
  if (!store) return null;
  return <GoalStatusChipView key={sessionId} store={store} compact={compact} />;
}

function GoalStatusChipView({
  store,
  compact,
}: {
  store: StoreApi<ChatStore>;
  compact?: boolean;
}) {
  const goal = useStore(
    store,
    useCallback((s: ChatStore) => s.goal, []),
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // 编辑对话框草稿（打开菜单项时从 goal 初始化）
  const [draftObjective, setDraftObjective] = useState('');
  const [draftBudget, setDraftBudget] = useState('');

  const runAction = useCallback(async (
    action: () => Promise<void>,
    errorMessage: string,
  ) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      console.error('[GoalStatusChip] action failed:', error);
      showGlobalNotification('error', errorMessage);
    } finally {
      setBusy(false);
    }
  }, []);

  if (!goal) return null;

  const meta = GOAL_STATUS_META[goal.status] ?? GOAL_STATUS_META.paused;
  const canPause = goal.status === 'active' || goal.status === 'waiting_user';
  const canResume = goal.status === 'paused'
    || goal.status === 'blocked'
    || goal.status === 'budget_limited'
    || goal.status === 'usage_limited';
  const isComplete = goal.status === 'complete';
  // active / waiting_user 时附已用 token（千分位）
  const showTokens = goal.status === 'active' || goal.status === 'waiting_user';

  const openEditDialog = () => {
    setDraftObjective(goal.objective);
    setDraftBudget(goal.tokenBudget != null ? String(goal.tokenBudget) : '');
    setEditOpen(true);
  };

  const handleEditConfirm = () => {
    const objective = draftObjective.trim();
    if (!objective) return;
    const budgetRaw = draftBudget.trim();
    const budgetNum = budgetRaw ? Number(budgetRaw) : undefined;
    const tokenBudget = budgetNum !== undefined && Number.isFinite(budgetNum) && budgetNum > 0
      ? Math.floor(budgetNum)
      : undefined;
    void runAction(async () => {
      await store.getState().editGoal(objective, tokenBudget);
      setEditOpen(false);
    }, '编辑目标失败');
  };

  const triggerLabel = `会话目标：${meta.label}`;

  return (
    <>
      <AppMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <AppMenuTrigger asChild>
          {compact ? (
            <button
              type="button"
              data-no-drag
              className={cn(
                'relative flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground',
                'transition-colors hover:bg-muted/60 hover:text-foreground',
              )}
              aria-label={triggerLabel}
              title={triggerLabel}
            >
              {renderStatusIcon(goal.status, 18)}
              <span
                aria-hidden
                className={cn(
                  'absolute right-0.5 top-0.5 h-2 w-2 rounded-full',
                  meta.dotClassName,
                )}
              />
            </button>
          ) : (
            <button
              type="button"
              data-no-drag
              className={cn(
                'flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border/50 bg-muted/40 px-2.5',
                'text-caption text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground',
              )}
              aria-label={triggerLabel}
              title={goal.objective}
            >
              {renderStatusIcon(goal.status, 13)}
              <span className="max-w-[10rem] truncate">{meta.label}</span>
              {showTokens && (
                <span className="tabular-nums text-muted-foreground/70">
                  {formatTokenCount(goal.tokensUsed)}
                </span>
              )}
            </button>
          )}
        </AppMenuTrigger>

        <AppMenuContent
          align={compact ? 'end' : 'start'}
          width={220}
          style={{ zIndex: Z_INDEX.composerPanel }}
        >
          <AppMenuLabel>
            <div className="flex min-w-0 flex-col gap-0.5 py-0.5">
              <span className="line-clamp-2 break-all text-caption leading-snug">
                {goal.objective}
              </span>
              <span className="tabular-nums text-caption text-muted-foreground">
                {formatTokenCount(goal.tokensUsed)}
                {goal.tokenBudget != null ? ` / ${formatTokenCount(goal.tokenBudget)}` : ''}
                {' tokens'}
              </span>
            </div>
          </AppMenuLabel>
          <AppMenuSeparator />
          {canPause && (
            <AppMenuItem
              icon={<Pause size={16} />}
              disabled={busy}
              onClick={() => void runAction(() => store.getState().pauseGoal(), '暂停目标失败')}
            >
              暂停
            </AppMenuItem>
          )}
          {canResume && (
            <AppMenuItem
              icon={<Play size={16} />}
              disabled={busy}
              onClick={() => void runAction(() => store.getState().resumeGoal(), '继续目标失败')}
            >
              继续
            </AppMenuItem>
          )}
          {!isComplete && (
            <AppMenuItem
              icon={<PencilSimple size={16} />}
              onClick={openEditDialog}
            >
              编辑目标
            </AppMenuItem>
          )}
          <AppMenuItem
            icon={<Trash size={16} />}
            destructive
            disabled={busy}
            onClick={() => setClearOpen(true)}
          >
            清除目标
          </AppMenuItem>
        </AppMenuContent>
      </AppMenu>

      {/* 编辑目标对话框 */}
      <DsDialog open={editOpen} onOpenChange={setEditOpen} maxWidth="max-w-md">
        <DsDialogHeader>
          <DsDialogTitle>编辑目标</DsDialogTitle>
        </DsDialogHeader>
        <DsDialogBody>
          <div className="flex flex-col gap-3">
            <Textarea
              value={draftObjective}
              onChange={(event) => setDraftObjective(event.target.value)}
              rows={3}
              placeholder="目标描述"
              aria-label="目标描述"
            />
            <Input
              value={draftBudget}
              onChange={(event) => setDraftBudget(event.target.value)}
              type="number"
              min={1}
              placeholder="token 预算（可选，留空不限）"
              aria-label="token 预算"
            />
          </div>
        </DsDialogBody>
        <DsDialogFooter>
          <DsButton variant="ghost" size="sm" onClick={() => setEditOpen(false)} disabled={busy}>
            取消
          </DsButton>
          <DsButton
            variant="primary"
            size="sm"
            onClick={handleEditConfirm}
            disabled={busy || !draftObjective.trim()}
          >
            保存
          </DsButton>
        </DsDialogFooter>
      </DsDialog>

      {/* 清除目标二次确认 */}
      <DsAlertDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="清除目标"
        description="清除后系统将停止该目标的自动续跑，此操作不可撤销。"
        confirmText="清除"
        loading={busy}
        onConfirm={() => {
          setClearOpen(false);
          void runAction(() => store.getState().clearGoal(), '清除目标失败');
        }}
      />
    </>
  );
}
