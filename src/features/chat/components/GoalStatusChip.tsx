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
import { useTranslation } from 'react-i18next';
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
  /** 短文本标签 i18n 键（chatV2:goal.status.*） */
  labelKey: string;
  /** 图标着色（Tailwind 语义色） */
  iconClassName: string;
  /** 状态点着色（compact 模式） */
  dotClassName: string;
}

const GOAL_STATUS_META: Record<GoalStatus, GoalStatusMeta> = {
  active: {
    labelKey: 'goal.status.active',
    iconClassName: 'text-primary',
    dotClassName: 'bg-primary',
  },
  waiting_user: {
    labelKey: 'goal.status.waitingUser',
    iconClassName: 'text-warning',
    dotClassName: 'bg-warning',
  },
  paused: {
    labelKey: 'goal.status.paused',
    iconClassName: 'text-muted-foreground',
    dotClassName: 'bg-muted-foreground',
  },
  blocked: {
    labelKey: 'goal.status.blocked',
    iconClassName: 'text-destructive',
    dotClassName: 'bg-destructive',
  },
  budget_limited: {
    labelKey: 'goal.status.budgetLimited',
    iconClassName: 'text-warning',
    dotClassName: 'bg-warning',
  },
  usage_limited: {
    labelKey: 'goal.status.usageLimited',
    iconClassName: 'text-warning',
    dotClassName: 'bg-warning',
  },
  complete: {
    labelKey: 'goal.status.complete',
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
  const { t } = useTranslation('chatV2');
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
    }, t('goal.errors.edit'));
  };

  const statusLabel = t(meta.labelKey);
  const triggerLabel = t('goal.triggerLabel', { status: statusLabel });

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
              <span className="max-w-[10rem] truncate">{statusLabel}</span>
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
              onClick={() => void runAction(() => store.getState().pauseGoal(), t('goal.errors.pause'))}
            >
              {t('goal.pause')}
            </AppMenuItem>
          )}
          {canResume && (
            <AppMenuItem
              icon={<Play size={16} />}
              disabled={busy}
              onClick={() => void runAction(() => store.getState().resumeGoal(), t('goal.errors.resume'))}
            >
              {t('goal.resume')}
            </AppMenuItem>
          )}
          {!isComplete && (
            <AppMenuItem
              icon={<PencilSimple size={16} />}
              onClick={openEditDialog}
            >
              {t('goal.edit')}
            </AppMenuItem>
          )}
          <AppMenuItem
            icon={<Trash size={16} />}
            destructive
            disabled={busy}
            onClick={() => setClearOpen(true)}
          >
            {t('goal.clear')}
          </AppMenuItem>
        </AppMenuContent>
      </AppMenu>

      {/* 编辑目标对话框 */}
      <DsDialog open={editOpen} onOpenChange={setEditOpen} maxWidth="max-w-md">
        <DsDialogHeader>
          <DsDialogTitle>{t('goal.edit')}</DsDialogTitle>
        </DsDialogHeader>
        <DsDialogBody>
          <div className="flex flex-col gap-3">
            <Textarea
              value={draftObjective}
              onChange={(event) => setDraftObjective(event.target.value)}
              rows={3}
              placeholder={t('goal.objectivePlaceholder')}
              aria-label={t('goal.objectivePlaceholder')}
            />
            <Input
              value={draftBudget}
              onChange={(event) => setDraftBudget(event.target.value)}
              type="number"
              min={1}
              placeholder={t('goal.budgetPlaceholder')}
              aria-label={t('goal.budgetAriaLabel')}
            />
          </div>
        </DsDialogBody>
        <DsDialogFooter>
          <DsButton variant="ghost" size="sm" onClick={() => setEditOpen(false)} disabled={busy}>
            {t('goal.cancel')}
          </DsButton>
          <DsButton
            variant="primary"
            size="sm"
            onClick={handleEditConfirm}
            disabled={busy || !draftObjective.trim()}
          >
            {t('goal.save')}
          </DsButton>
        </DsDialogFooter>
      </DsDialog>

      {/* 清除目标二次确认 */}
      <DsAlertDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title={t('goal.clear')}
        description={t('goal.clearConfirmDescription')}
        confirmText={t('goal.clearConfirm')}
        loading={busy}
        onConfirm={() => {
          setClearOpen(false);
          void runAction(() => store.getState().clearGoal(), t('goal.errors.clear'));
        }}
      />
    </>
  );
}
