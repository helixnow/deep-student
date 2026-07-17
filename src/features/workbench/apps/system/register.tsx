/**
 * 系统应用群注册（P9）
 *
 * 系统应用（全部 single——各页面依赖全局 store / 全局数据，天然单例）：
 * - todo          待办（TodoContentView + TodoShellSidebar）
 * - skills        技能管理（SkillsManagementPage）
 * - templates     模板管理（TemplateManagementPage）
 * - taskDashboard 制卡任务（TaskDashboardPage，Dock 角标 = 活跃任务数）
 * - flashcards    闪卡复习（FlashcardsApp，Dock 角标 = 到期数，M3 占位）
 * - settings      设置（Settings + SettingsShellSidebar）
 * - pomodoro      番茄钟（PomodoroPanel，投射目标，Dock 角标 = 运行中圆点）
 *
 * 由 P11 在 workbench 启动入口（apps/registerAll）统一调用 registerSystemApps()。
 */
import React from 'react';
import { AppIconImage } from '../../icons/appIcons';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { appRegistry } from '../../core/appRegistry';
import type { ActivationContext } from '../../core/types';
import { ankiTaskBadgeSource } from './ankiTaskSource';
import { flashcardsDueBadgeSource } from './flashcardsDueSource';
import { pomodoroBadgeSource } from './pomodoroSource';
import { handleTodoActivation } from './todoActivation';
import {
  createFlashcardsAgentManifest,
  createPomodoroAgentManifest,
  settingsAgentManifest,
  taskDashboardAgentManifest,
  templatesAgentManifest,
  todoAgentManifest,
} from './agentManifests';

/** Flashcards 语义控制；不开放代替用户评分。 */
export async function handleFlashcardsActivation(ctx: ActivationContext) {
  const { useFsrsReviewStore } = await import('@/features/flashcards/store/fsrsReviewStore');
  const store = useFsrsReviewStore.getState();
  const startDueReview = async () => {
    if (!(await store.loadDue())) {
      return {
        handled: false,
        code: 'LOAD_FAILED',
        hint: useFsrsReviewStore.getState().error ?? '到期卡加载失败',
      } as const;
    }
    useFsrsReviewStore.getState().startDueSession();
    return { handled: true } as const;
  };
  switch (ctx.action) {
    case 'startReview': {
      const payload = ctx.payload && typeof ctx.payload === 'object'
        ? ctx.payload as { screen?: unknown; mode?: unknown; cardIds?: unknown; cards?: unknown }
        : null;
      if (payload?.screen === 'session' && payload.mode === 'due') {
        return startDueReview();
      }
      if (payload?.screen === 'session' && payload.mode === 'batch' && Array.isArray(payload.cardIds)) {
        const ids = payload.cardIds.filter((id): id is string => typeof id === 'string');
        const cards = Array.isArray(payload.cards)
          ? payload.cards as Parameters<typeof store.startBatchSession>[1]
          : undefined;
        if (!(await store.startBatchSession(ids, cards))) {
          return {
            handled: false,
            code: 'ENQUEUE_FAILED',
            hint: useFsrsReviewStore.getState().error ?? '复习批次准备失败',
          } as const;
        }
        return { handled: true } as const;
      }
      store.applyLaunchPayload(ctx.payload);
      return { handled: true } as const;
    }
    case 'showScreen': {
      const screen = ctx.payload && typeof ctx.payload === 'object'
        ? (ctx.payload as { screen?: unknown }).screen
        : undefined;
      if (screen !== 'today' && screen !== 'library' && screen !== 'settings' && screen !== 'session') {
        return { handled: false, code: 'INVALID_ARGS', hint: 'screen 值无效' } as const;
      }
      store.setScreen(screen);
      return { handled: true } as const;
    }
    case 'startDueReview':
      return startDueReview();
    case 'flipCard':
      if (store.screen !== 'session') {
        return { handled: false, code: 'INVALID_STATE', hint: '当前不在复习会话中' } as const;
      }
      store.flip();
      return { handled: true } as const;
    case 'endReview':
      store.endSession();
      return { handled: true } as const;
    default:
      return {
        handled: false,
        code: 'UNKNOWN_ACTION',
        hint: `Flashcards 不支持指令 ${ctx.action}`,
      } as const;
  }
}

/**
 * pomodoro onActivation — R1-16 / R2-10
 * start/{taskId,taskTitle} · pause · resume · stop。
 * 返回值供 StageManager app_command 结构化回执（strictMode → handled:false + STRICT_MODE）。
 * start 后由 pomodoroProjectionSource 订阅 mode 变化自动投射开窗（时序：store 先变 → notify → project）。
 */
export type PomodoroActivationResult =
  | { handled: true }
  | { handled: false; code: string; hint: string };

const POMODORO_STRICT_HINT = '严格模式下专注中不可暂停';

export function handlePomodoroActivation(ctx: ActivationContext): PomodoroActivationResult {
  const store = usePomodoroStore.getState();
  switch (ctx.action) {
    case 'start': {
      let taskId: string | undefined;
      let taskTitle: string | undefined;
      if (ctx.payload && typeof ctx.payload === 'object') {
        const p = ctx.payload as { taskId?: unknown; taskTitle?: unknown };
        if (typeof p.taskId === 'string') taskId = p.taskId;
        if (typeof p.taskTitle === 'string') taskTitle = p.taskTitle;
      }
      store.start(taskId, taskTitle);
      return { handled: true };
    }
    case 'pause': {
      if (store.settings.strictMode && store.mode === 'work' && store.status === 'running') {
        console.warn(`[workbench:pomodoro] pause ignored: STRICT_MODE ${POMODORO_STRICT_HINT}`);
        return {
          handled: false,
          code: 'STRICT_MODE',
          hint: POMODORO_STRICT_HINT,
        };
      }
      store.pause();
      return { handled: true };
    }
    case 'resume': {
      store.resume();
      return { handled: true };
    }
    case 'stop': {
      store.stop(true);
      return { handled: true };
    }
    default:
      console.warn(`[workbench:pomodoro] unknown activation action: ${ctx.action}`);
      return {
        handled: false,
        code: 'UNKNOWN_ACTION',
        hint: `不支持的 pomodoro action: ${ctx.action}`,
      };
  }
}

let registered = false;

/** 幂等注册全部系统应用 */
export function registerSystemApps(): void {
  if (registered) return;
  registered = true;

  appRegistry.register({
    typeId: 'todo',
    nameKey: 'workbench:apps.todo',
    icon: <AppIconImage typeId="todo" className="h-8 w-8" />,
    instanceMode: 'single',
    memoryWeight: 2,
    defaultFrame: { w: 920, h: 660 },
    minSize: { w: 560, h: 420 },
    render: React.lazy(() => import('./TodoAppWindow')),
    // R1-14：showList / focusItem（store 在 handler 内动态 import）
    onActivation: handleTodoActivation,
    agentManifest: todoAgentManifest,
  });

  appRegistry.register({
    typeId: 'skills',
    nameKey: 'workbench:apps.skills',
    icon: <AppIconImage typeId="skills" className="h-8 w-8" />,
    instanceMode: 'single',
    memoryWeight: 2,
    defaultFrame: { w: 980, h: 680 },
    minSize: { w: 640, h: 460 },
    render: React.lazy(() => import('./SkillsAppWindow')),
  });

  appRegistry.register({
    typeId: 'templates',
    nameKey: 'workbench:apps.templates',
    icon: <AppIconImage typeId="templates" className="h-8 w-8" />,
    instanceMode: 'single',
    memoryWeight: 2,
    defaultFrame: { w: 980, h: 680 },
    minSize: { w: 640, h: 460 },
    render: React.lazy(() => import('./TemplatesAppWindow')),
    agentManifest: templatesAgentManifest,
  });

  appRegistry.register({
    typeId: 'taskDashboard',
    nameKey: 'workbench:apps.taskDashboard',
    icon: <AppIconImage typeId="taskDashboard" className="h-8 w-8" />,
    instanceMode: 'single',
    memoryWeight: 1,
    defaultFrame: { w: 920, h: 660 },
    minSize: { w: 600, h: 440 },
    render: React.lazy(() => import('./TaskDashboardAppWindow')),
    badgeSource: ankiTaskBadgeSource,
    agentManifest: taskDashboardAgentManifest,
  });

  appRegistry.register({
    typeId: 'flashcards',
    nameKey: 'workbench:apps.flashcards',
    icon: <AppIconImage typeId="flashcards" className="h-8 w-8" />,
    instanceMode: 'single',
    memoryWeight: 2,
    defaultFrame: { w: 960, h: 680 },
    minSize: { w: 560, h: 440 },
    render: React.lazy(() => import('./FlashcardsAppWindow')),
    badgeSource: flashcardsDueBadgeSource,
    // R1-15：startReview → applyLaunchPayload
    onActivation: handleFlashcardsActivation,
    agentManifest: createFlashcardsAgentManifest(handleFlashcardsActivation),
  });

  appRegistry.register({
    typeId: 'settings',
    nameKey: 'workbench:apps.settings',
    icon: <AppIconImage typeId="settings" className="h-8 w-8" />,
    instanceMode: 'single',
    memoryWeight: 2,
    defaultFrame: { w: 1020, h: 700 },
    minSize: { w: 720, h: 520 },
    render: React.lazy(() => import('./SettingsAppWindow')),
    agentManifest: settingsAgentManifest,
  });

  appRegistry.register({
    typeId: 'pomodoro',
    nameKey: 'workbench:apps.pomodoro',
    icon: <AppIconImage typeId="pomodoro" className="h-8 w-8" />,
    instanceMode: 'single',
    memoryWeight: 1,
    defaultFrame: { w: 380, h: 560 },
    minSize: { w: 320, h: 440 },
    render: React.lazy(() => import('./PomodoroAppWindow')),
    badgeSource: pomodoroBadgeSource,
    onActivation: handlePomodoroActivation,
    agentManifest: createPomodoroAgentManifest(handlePomodoroActivation),
  });
}
