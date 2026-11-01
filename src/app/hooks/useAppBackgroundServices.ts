import { useEffect } from 'react';
import type { i18n as I18n } from 'i18next';
import { registerBuiltinCommands } from '@/command-palette/registry/builtinCommands';
import { initReminderScheduler } from '@/features/todo/reminderScheduler';
import {
  ensureAutoSyncSchedulerStarted,
  ensureSyncProgressListener,
  useAutoSyncStore,
} from '@/stores/syncStatusStore';

/**
 * App 壳层：应用级后台服务的启动与清理——命令面板内置命令注册（语言切换后重注册）、
 * 待办提醒调度器、云同步进度监听、自动同步调度器（等 persist hydration）、制卡完成通知。
 * 从 App.tsx 原样搬出。
 */
export function useAppBackgroundServices(i18n: I18n) {
  // 🎯 命令面板：注册内置命令
  // ★ 2026-06-12：命令名在注册时经 i18next.t() 一次性求值,运行时切换语言后必须
  //   重新注册一遍,否则面板里仍显示旧语言文案
  useEffect(() => {
    let unregister = registerBuiltinCommands();
    const refreshOnLanguageChange = () => {
      unregister();
      unregister = registerBuiltinCommands();
    };
    i18n.on('languageChanged', refreshOnLanguageChange);
    return () => {
      i18n.off('languageChanged', refreshOnLanguageChange);
      unregister();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- i18n 为模块级单例,引用稳定
  }, []);

  // ⏰ 待办提醒调度器（应用级，到点弹系统通知）
  useEffect(() => initReminderScheduler(), []);

  // ☁️ 云同步进度（应用级监听，issue 447）：进度写入全局 useGlobalSyncStore，
  //   同步面板被设置页切栏目卸载/重挂载后仍能立即显示当前进度与取消入口。
  useEffect(() => {
    void ensureSyncProgressListener();
  }, []);

  // ☁️ 自动同步调度器（应用级主启动点，与 initReminderScheduler 同模式）：
  //   持久化开关为开时，重启后无需进设置页即恢复排程。必须等 persist
  //   hydration 完成后再 start——否则会用默认 enabled:false 误判为 no-op，
  //   或在持久化状态读入前误读开关。start() 本身防重（已排程/执行中直接
  //   return），ensureAutoSyncSchedulerStarted 幂等，StrictMode 双调用与
  //   设置页的兼容性调用都不会起第二个 timer；开关关闭时 start 为 no-op。
  useEffect(() => {
    const persistApi = useAutoSyncStore.persist as
      | typeof useAutoSyncStore.persist
      | undefined;
    // 极端环境（localStorage 不可用）下 persist 中间件未接 storage，
    // 无 hydration 阶段可等，直接按内存默认态启动（enabled:false → no-op）
    if (!persistApi) {
      ensureAutoSyncSchedulerStarted();
      return;
    }
    if (persistApi.hasHydrated()) {
      ensureAutoSyncSchedulerStarted();
      return;
    }
    return persistApi.onFinishHydration(() => {
      ensureAutoSyncSchedulerStarted();
    });
  }, []);

  // ★ 4.2 制卡完成通知（应用级，后台时发系统通知）
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    import('@/features/anki/ankiCompletionNotifier').then((m) => {
      cleanup = m.initAnkiCompletionNotifier();
    });
    return () => cleanup?.();
  }, []);
}
