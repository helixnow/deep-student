import { useEffect, useState } from 'react';
import type { i18n as I18n } from 'i18next';
// 停用事务（缝一）：模式开关 / 应用退出统一逐窗 canClose 预检。
// W38：这些模块属于桌面工作台；经宿主桥动态加载，移动端产物不包含它们。
import {
  flushWorkbenchSnapshot,
  hasDirtyWorkbenchWindows,
  installLegacyWorkbenchNavigation,
  runWorkbenchDeactivationTransaction,
} from '@/shared/workbenchHost';
import { loadWorkbenchHost } from '../workbench/load';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { APP_EVENTS, addAppEventListener } from '@/events';
import { isMobilePlatform } from '@/utils/platform';

/** workbench 模式的 localStorage 同步预读键（组件内 workbenchMode 初始态同源） */
export const WORKBENCH_MODE_CACHE_KEY = 'desktop.workbenchMode';

/**
 * App 壳层：Workbench（学习桌面）模式开关与平台护栏，以及 Workbench 激活期间的
 * 应用退出护栏（beforeunload 脏窗确认 / pagehide 快照落盘）。从 App.tsx 原样搬出；
 * 返回 workbenchActive。WORKBENCH_MODE_CACHE_KEY 同时供 App.tsx 模块级 chunk 预热使用。
 */
export function useWorkbenchMode(i18n: I18n) {
  // ★ Workbench 产品默认身份：localStorage 同步预读避免冷启动闪回 legacy 壳，
  //   再以 resolveWorkbenchModeEnabled 为准（缺失键 → true + 迁移哨兵）；
  //   监听设置页 workbench:mode-changed 即时切换（缓存键提升至模块级供预热复用）
  const [workbenchMode, setWorkbenchMode] = useState(() => {
    try {
      if (typeof localStorage === 'undefined') return true;
      // 显式 false 保留经典壳；缺失 / true → 学习桌面（产品默认）
      return localStorage.getItem(WORKBENCH_MODE_CACHE_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    // 桌面端宿主桥：先加载再安装 legacy 导航兜底（移动端 load 立即 resolve、桥为空）。
    void loadWorkbenchHost().then(() => installLegacyWorkbenchNavigation());
    let cancelled = false;
    const cacheMode = (enabled: boolean) => {
      try {
        localStorage.setItem(WORKBENCH_MODE_CACHE_KEY, String(enabled));
      } catch {
        /* private mode / quota */
      }
    };
    (async () => {
      try {
        const { resolveWorkbenchModeEnabled } = await import(
          '@/features/settings/components/workbenchMode'
        );
        const { enabled } = await resolveWorkbenchModeEnabled();
        if (cancelled) return;
        setWorkbenchMode(enabled);
        cacheMode(enabled);
      } catch {
        /* 默认启用；保留预读缓存 */
      }
    })();
    const dispose = addAppEventListener(APP_EVENTS.WORKBENCH_MODE_CHANGED, (detail) => {
      const enabled = Boolean(detail?.enabled);
      setWorkbenchMode(enabled);
      cacheMode(enabled);
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  // Workbench 仅桌面端生效（设计文档：移动端不适用，继续现有滑动布局）；
  // 平台护栏：宽屏 Android 平板 / iPad 同样不进 OS 模式（isMobilePlatform 永真拦截）。
  //
  // 桌面窄窗（<768px）不再卸载 Workbench（0824 评审建议 2，本轮裁决落地）：
  // 此前用 shellStableSmallScreen（250ms 宽度稳定迟滞）在持续窄窗时整壳硬切。
  // 迟滞只是渲染防抖，不是数据安全措施——250ms 到期后照样绕过逐窗 canClose /
  // windowCloseGuard 直接卸载所有窗口，未保存草稿静默丢失（快照契约只存壳，
  // 见 docs/0824-quality-review/workbench-fg.md 接缝一）。窄窗是布局问题而非
  // 生命周期问题：子应用已按容器宽度支持 compact，桌面平台恒保持 Workbench；
  // 需要停用工作台的路径（模式开关 / 应用退出）统一走
  // runWorkbenchDeactivationTransaction 逐窗预检，可取消、可回滚。
  // 页面内布局仍用即时 isSmallScreen，不受影响。
  const workbenchActive = workbenchMode && !isMobilePlatform();

  // 应用退出护栏（缝一 · app-exit 路径）：Workbench 激活期间若存在脏窗
  // （未保存更改），beforeunload 至少 preventDefault 触发系统级「确认离开」
  // 对话框——浏览器 / WebView 不允许在卸载时刻 await 自定义逐窗确认，事务
  // 只能异步补跑：用户选择留下后，逐窗保存 / 放弃对话框继续可用。
  // pagehide 不可取消，仅作快照兜底落盘（退出时 WorkbenchDesktop 的卸载
  // cleanup 不保证执行）。main.tsx 既有 beforeunload（MCP / ChatV2 紧急保存）
  // 与本钩子互不冲突，无需改 main.tsx。
  useEventRegistry(
    workbenchActive
      ? [
          {
            target: 'window' as const,
            type: 'beforeunload',
            listener: (event: Event) => {
              const beforeUnload = event as BeforeUnloadEvent;
              if (!hasDirtyWorkbenchWindows()) return;
              beforeUnload.preventDefault();
              // Chromium 系需要 returnValue 非空才可靠弹出原生确认；自定义文案不会被展示
              beforeUnload.returnValue = i18n.t('workbench:deactivation.dirtyBlocked', {
                defaultValue:
                  '有窗口存在未保存的更改，已阻止直接退出 / Unsaved changes in open windows blocked the exit.',
              });
              void runWorkbenchDeactivationTransaction('app-exit');
            },
          },
          {
            target: 'window' as const,
            type: 'pagehide',
            listener: () => {
              void flushWorkbenchSnapshot();
            },
          },
        ]
      : [],
    [workbenchActive, i18n],
  );

  return { workbenchActive };
}
