import React from 'react';
import { isMobilePlatform } from '@/utils/platform';
import { WORKBENCH_MODE_CACHE_KEY } from '@/app/hooks/useWorkbenchMode';

/**
 * Workbench（学习 OS 桌面）的两个懒加载宿主。
 *
 * 桌面本体是独立 lazy chunk，开关关闭时不加载；AgentBridge 常驻但 return null。
 * 移动端由构建期平台字面量直接折叠成 `() => null`，Rollup 因此整块删除 dynamic import
 * ——**不要**把该比较提成常量/参数，否则产物会重新包含 features/workbench。
 *
 * W38：从 App.tsx 原样搬出（chunk 说明符与判定顺序不变；预热仍在 App 模块求值期调用）。
 */
export const LazyAgentBridge = React.lazy((): Promise<{ default: React.ComponentType<{ workbenchActive: boolean }> }> =>
  import.meta.env.VITE_DS_PLATFORM === 'mobile'
    ? Promise.resolve({ default: () => null })
    : import('@/features/workbench/agent/AgentBridge').then(({ AgentBridge }) => ({ default: AgentBridge })),
);

// 工厂提成共享常量：React.lazy 与预热 import() 指向同一模块说明符，命中同一 chunk
const importWorkbenchDesktop = (): Promise<{ default: React.ComponentType }> =>
  import.meta.env.VITE_DS_PLATFORM === 'mobile'
    ? Promise.resolve({ default: () => null })
    : import('@/features/workbench/components/WorkbenchDesktop');
export const LazyWorkbenchDesktop = React.lazy(importWorkbenchDesktop);

/**
 * Workbench chunk 预热：OS 模式是产品默认（缺失键 → true），冷启动大概率要挂
 * WorkbenchDesktop——在模块求值期用与 workbenchMode 初始态同源的 localStorage
 * 同步预读判定后立即发起 import()，与首屏渲染并行拉取 chunk，消除瀑布式加载。
 * 不 await、错误吞掉（真正挂载时 Suspense 会正常重试/报错）。
 * 注意与 workbenchActive 的平台护栏保持一致：移动端不预热。
 * 快捷助手等辅助窗口（?window=...）不预热：它们也求值本模块，但 Workbench 闭包发出的
 * 主窗级调用会被辅助窗最小 capability 拒绝，判定与 main.tsx 的 UI 桥一致。
 */
export function prewarmWorkbenchDesktop(): void {
  try {
    if (
      import.meta.env.VITE_DS_PLATFORM !== 'mobile' &&
      typeof localStorage !== 'undefined' &&
      localStorage.getItem(WORKBENCH_MODE_CACHE_KEY) !== 'false' &&
      !isMobilePlatform() &&
      new URLSearchParams(window.location.search).get('window') === null
    ) {
      void importWorkbenchDesktop().catch(() => { /* 预热失败无所谓，挂载时再拉 */ });
    }
  } catch { /* localStorage 不可用（隐私模式等）则跳过预热 */ }
}
