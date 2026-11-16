/**
 * `dstu.plugin-services`：给社区插件与工坊作品用的应用服务（docs/plugins/SDK.md §3.6–§3.9）。
 *
 * - `pluginSecrets`：按插件隔离的密钥（安全存储）；
 * - `pluginNotify`：系统通知，点开时打开插件视图；
 * - `pluginSchedule`：每天 / 每周 / 间隔 / 启动时任务，错过的补跑一次；
 * - `studyData`：笔记、卡片、题库、复习、待办、资料库的稳定门面。
 *
 * 官方数据服务都在调用时按名取用（`ctx.get`），某个官方插件停用时只有用到它的方法报错，其余服务照常。
 */
import { definePlugin } from '../../kernel/api.ts';
import type {} from '../../platform/settings/api.ts';
import type {} from './api.ts';
import { PluginNotify } from './src/notify.ts';
import { PluginSchedule, PluginScheduler, settingsSchedulerStore } from './src/schedule.ts';
import { PluginSecrets } from './src/secrets.ts';
import { createStudyDataService } from './src/study-data.ts';

export default definePlugin({
  meta: {
    id: 'dstu.plugin-services',
    displayName: 'Plugin services',
    description: 'Secrets, notifications, schedules and study data for community plugins',
    provides: ['pluginSecrets', 'pluginNotify', 'pluginSchedule', 'studyData'],
    platforms: ['desktop'],
  },
  inject: ['settings'],
  apply(ctx) {
    const log = ctx.logger('dstu.plugin-services');
    const scheduler = new PluginScheduler(
      settingsSchedulerStore(() => ctx.get('settings') as typeof ctx.settings | undefined),
      {
        now: () => Date.now(),
        setInterval: (fn, ms) => {
          const handle = setInterval(fn, ms) as unknown as { unref?: () => void };
          handle.unref?.();
          return handle;
        },
        clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      },
      { warn: (message) => log.warn(message) },
    );
    ctx.effect(() => () => scheduler.dispose(), 'pluginSchedule.scheduler');
    new PluginSecrets(ctx);
    new PluginNotify(ctx);
    new PluginSchedule(ctx, scheduler);
    ctx.provide('studyData', createStudyDataService(ctx));
  },
});
