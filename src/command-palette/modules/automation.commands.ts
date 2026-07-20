/**
 * 定时任务（自动化）命令
 * 入口整合：打开视图 / 新建任务 / 后台自动化总开关。
 *
 * 文案取自 todo 命名空间的 automation.entry.* 子树（中英双写）。
 */

import { Pause, Play, Plus, Robot } from '@phosphor-icons/react';
import i18next from 'i18next';
import type { Command } from '../registry/types';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { useAutomationStore } from '@/features/todo/stores/useAutomationStore';
import {
  AUTOMATION_REQUEST_CREATE_EVENT,
  requestAutomationCreate,
} from '@/features/todo/automationCreateRequest';

// ============================================================================
// 事件名常量 — 命令面板 dispatch / 自动化工作区 addEventListener 共享
// （真实来源在 automationCreateRequest.ts，此处保留导出以兼容旧引用）
// ============================================================================

export const AUTOMATION_EVENTS = {
  /** 请求在自动化工作区打开"新建任务"表单 */
  REQUEST_CREATE: AUTOMATION_REQUEST_CREATE_EVENT,
} as const;

/** 与 StatusBar / todoActivation 一致的 showAutomations 打开路径 */
function openAutomationsWorkspace(): Promise<boolean> {
  return workbenchBus.activate({
    typeId: 'todo',
    instanceKey: '',
    action: 'showAutomations',
    fallbackLaunch: {
      typeId: 'todo',
      reason: 'api',
      payload: { todoView: 'automations' },
    },
  });
}

/**
 * 后台自动化总开关。
 *
 * 语义（读自 src-tauri chat_v2/automations.rs）：
 * `chat_v2_automation_set_background_enabled` 只写入
 * `chat_v2.automation_background_enabled` 设置并广播 automations_changed；
 * 它决定关闭主窗口后是否保留后台运行（should_keep_automation_background），
 * 不修改任何单个任务的 enabled 状态，应用在前台时调度器照常运行。
 * 因此选它作为"暂停/恢复"命令：可无损往返，不破坏每个任务的启用配置；
 * 命令描述里明确说明这是"后台运行"开关。
 *
 * 统一走 useAutomationStore.setBackgroundEnabled（乐观更新 + 失败回滚），
 * 保证自动化工作区 / 设置区的开关 UI 即时同步，而不是等 automations_changed 事件。
 */
function setBackgroundEnabled(enabled: boolean): Promise<void> {
  return useAutomationStore.getState().setBackgroundEnabled(enabled);
}

const KEYWORDS = ['自动化', '定时任务', '定时', 'automation', 'automations', 'schedule', 'scheduled', 'cron'];

export const automationCommands: Command[] = [
  {
    id: 'automation.open',
    get name() { return i18next.t('todo:automation.entry.openCommand', 'Open Scheduled Tasks'); },
    get description() { return i18next.t('todo:automation.entry.openCommandDesc', 'Switch to the todo automations view'); },
    category: 'global',
    icon: Robot,
    keywords: KEYWORDS,
    priority: 60,
    execute: () => {
      void openAutomationsWorkspace();
    },
  },
  {
    id: 'automation.create',
    get name() { return i18next.t('todo:automation.entry.createCommand', 'New Scheduled Task'); },
    get description() { return i18next.t('todo:automation.entry.createCommandDesc', 'Open the automations view and start creating a task'); },
    category: 'global',
    icon: Plus,
    keywords: KEYWORDS,
    priority: 59,
    execute: async () => {
      await openAutomationsWorkspace();
      // 带 pending 标记的请求：工作区若尚未挂载完成，挂载时会补消费并打开创建面板
      requestAutomationCreate();
    },
  },
  {
    id: 'automation.pause-background',
    get name() { return i18next.t('todo:automation.entry.pauseBackgroundCommand', 'Pause Background Automations'); },
    get description() { return i18next.t('todo:automation.entry.pauseBackgroundCommandDesc', 'Turn off the background switch: tasks stop running after the window closes; per-task enabled states are untouched'); },
    category: 'global',
    icon: Pause,
    keywords: KEYWORDS,
    priority: 58,
    execute: async (deps) => {
      try {
        await setBackgroundEnabled(false);
        deps.showNotification('success', i18next.t('todo:automation.entry.pauseBackgroundDone', 'Background automations paused'));
      } catch {
        deps.showNotification('error', i18next.t('todo:automation.entry.backgroundToggleFailed', 'Failed to toggle background automations'));
      }
    },
  },
  {
    id: 'automation.resume-background',
    get name() { return i18next.t('todo:automation.entry.resumeBackgroundCommand', 'Resume Background Automations'); },
    get description() { return i18next.t('todo:automation.entry.resumeBackgroundCommandDesc', 'Allow scheduled tasks to keep running in the background after the window closes'); },
    category: 'global',
    icon: Play,
    keywords: KEYWORDS,
    priority: 57,
    execute: async (deps) => {
      try {
        await setBackgroundEnabled(true);
        deps.showNotification('success', i18next.t('todo:automation.entry.resumeBackgroundDone', 'Background automations resumed'));
      } catch {
        deps.showNotification('error', i18next.t('todo:automation.entry.backgroundToggleFailed', 'Failed to toggle background automations'));
      }
    },
  },
];
