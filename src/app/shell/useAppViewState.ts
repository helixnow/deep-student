import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { useSlot } from '@/ui-kernel/react';
import type { ShellViewContribution } from '@/ui-kernel/contracts/shell';
import type { CurrentView } from '@/types/navigation';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { resolveShellView } from '@/ui-plugins/official/shell/navigation';
import { pageLifecycleTracker } from '@/debug-panel/services/pageLifecycleTracker';
import { advanceViewNavStack, computeNextVisitedViews } from '@/app/navigation/viewRouting';
import { useViewRedirects } from '@/app/hooks/useViewRedirects';
import { rememberCardsHubView } from '@/app/navigation/cardsHub';
import { useViewStore } from '@/stores/viewStore';
import { setActiveOpenResourceHandler } from '@/dstu/openResource';

interface AppViewStateOptions {
  isSmallScreen: boolean;
  isDemoShell: boolean;
}

/**
 * 经典壳的视图状态：当前视图、访问过视图的 LRU、切换方向与切换到 `views` 槽位条目的解析。
 *
 * `setCurrentView` 保持稳定引用（`[]` 依赖，经 ref 读最新槽位），切换与 LRU 更新在同一个
 * `startTransition` 内提交，切换方向与视图同批更新。视图切换的诊断日志也在此收口。
 * W38：从 App.tsx 原样搬出；`isDemoShell` 的演示壳收窄判定不变。
 */
export function useAppViewState({ isSmallScreen, isDemoShell }: AppViewStateOptions) {
  const viewEntries = useSlot<ShellViewContribution>('views');
  const [currentView, setCurrentViewRaw] = useState<CurrentView>('chat-v2');
  const activeView = viewEntries.find(entry => entry.key === currentView)?.value;
  const activeShell = activeView?.shell;
  // Stable navigation callbacks read the latest registry without invalidating all
  // memoized page elements whenever a plugin changes its contributions.
  const viewEntriesRef = useRef(viewEntries);
  viewEntriesRef.current = viewEntries;
  // 视图切换方向（仅 <768px 的层滑动画消费；桌面是纵向淡入淡出无方向语义）。
  // 访问栈模型：目标是栈内已有视图 → 「返回」(-1)，未见过的新视图 → 「前进」(+1)。
  // 在 setCurrentView 内与视图切换同批 setState，保证动画首帧方向即正确。
  const viewNavStackRef = useRef<CurrentView[]>(['chat-v2']);
  const [viewNavDirection, setViewNavDirection] = useState<1 | -1>(1);
  const currentViewRef = useRef<CurrentView>('chat-v2');
  const isSmallScreenRef = useRef(isSmallScreen);
  const viewSwitchStartRef = useRef<{ from: CurrentView; to: CurrentView; startTime: number } | null>(null);

  // 🚀 性能优化：追踪已访问的页面，只渲染访问过的页面
  // 使用 Map<view, timestamp> 实现 LRU 淘汰，避免保活视图无限增长
  const [visitedViews, setVisitedViews] = useState<Map<CurrentView, number>>(
    () => new Map<CurrentView, number>([['chat-v2', Date.now()]])
  );

  useEffect(() => {
    isSmallScreenRef.current = isSmallScreen;
  }, [isSmallScreen]);

  // committed 视图的副作用：访问记录、外部 store 发布、资源 handler、切换耗时双 RAF。
  useEffect(() => {
    currentViewRef.current = currentView;
    // 闪卡中心：记住最近访问的分区，侧栏「闪卡」入口点击时回到这里
    rememberCardsHubView(currentView);
    // Publish committed navigation only; external-store writes cannot be deferred by startTransition.
    useViewStore.getState().setCurrentView(currentView);

    if (currentView === 'learning-hub') {
      setActiveOpenResourceHandler('learning-hub');
    } else if (currentView === 'chat-v2') {
      setActiveOpenResourceHandler('chat-v2');
    }

    // 调试追踪关闭时不安排双 RAF。生产环境每次导航都安排两帧回调，
    // 即使 tracker 不消费事件，也会把测量工作叠加到用户的切换路径上。
    if (!pageLifecycleTracker.isEnabled()) {
      viewSwitchStartRef.current = null;
      return;
    }

    // 记录视图切换完成和渲染耗时
    if (viewSwitchStartRef.current && viewSwitchStartRef.current.to === currentView) {
      const { from, to, startTime } = viewSwitchStartRef.current;
      const reactDuration = Math.round(performance.now() - startTime);

      pageLifecycleTracker.log(
        'app',
        'App.tsx',
        'render_end',
        `React: ${reactDuration}ms | ${from} → ${to}`,
        { duration: reactDuration }
      );

      // 使用 requestAnimationFrame 测量真正的浏览器渲染完成时间
      const rafStart = performance.now();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const paintDuration = Math.round(performance.now() - startTime);
          const rafDelta = Math.round(performance.now() - rafStart);
          pageLifecycleTracker.log(
            'app',
            'App.tsx',
            'custom',
            `Paint完成: ${paintDuration}ms (RAF: ${rafDelta}ms) | ${from} → ${to}`,
            { duration: paintDuration }
          );
        });
      });

      viewSwitchStartRef.current = null;
    }
  }, [currentView]);

  // 包装 setCurrentView，添加视图切换追踪 + LRU 淘汰
  const setCurrentView = useCallback((newView: CurrentView | ((prev: CurrentView) => CurrentView)) => {
    const prevView = currentViewRef.current;
    const rawTargetView = typeof newView === 'function' ? newView(prevView) : newView;
    const targetView = resolveShellView(rawTargetView, viewEntriesRef.current);

    // 演示壳收窄：只保留主会话页交互，次级页面入口点击不响应
    //（对应 lazy 页面模块已在 vite.demo.config.ts 中 stub 剔除，不会被打包/加载）
    if (isDemoShell && !viewEntriesRef.current.find(entry => entry.key === targetView)?.value.allowInDemo) return;

    if (targetView !== prevView) {
      if (pageLifecycleTracker.isEnabled()) {
        viewSwitchStartRef.current = { from: prevView, to: targetView, startTime: performance.now() };
      }

      pageLifecycleTracker.log(
        'app',
        'App.tsx',
        'view_switch',
        `${prevView} → ${targetView}`
      );

      // 视图切换广播：让 portal 到 body 的浮层（如输入栏组合面板）在宿主视图被隐藏时自行关闭，
      // 避免命令面板/程序化导航等无 pointerdown 的切换路径留下悬浮残影
      dispatchAppEvent(APP_EVENTS.VIEW_SWITCHED, { from: prevView, to: targetView });
    }

    // 使用 startTransition 将 LRU 更新 + 视图切换 打包在同一个 transition 中。
    // 导航历史由 useNavigationHistory 的 useEffect 推入（始终基于 committed state，避免快速点击竞态）。
    startTransition(() => {
      // 切换方向：与视图切换同批提交，层动画首帧即拿到正确方向（前进右入/后退左入镜像）
      advanceViewNavStack(viewNavStackRef.current, prevView, targetView, setViewNavDirection);

      // 🚀 LRU 更新：记录访问时间戳，超过阈值时淘汰最久未访问的非 pinned 视图
      setVisitedViews(prev => computeNextVisitedViews(prev, targetView));
      setCurrentViewRaw(targetView);
    });
  }, [isDemoShell]);

  // 启动恢复回执跳转设置页；UI Lab 关闭时退出 ui-lab 视图
  const { uiLabEnabled } = useViewRedirects(currentView, setCurrentView);

  // 🔍 诊断：分离调度延迟 vs 渲染时间（找出 200-400ms 的真正来源）
  useEffect(() => {
    if (!viewSwitchStartRef.current || viewSwitchStartRef.current.to !== currentView) return;
    const hooksMs = Math.round(performance.now() - viewSwitchStartRef.current.startTime);
    pageLifecycleTracker.log('app', 'App.tsx', 'custom', `⏱ Hooks+调度: ${hooksMs}ms | ${viewSwitchStartRef.current.from} → ${currentView}`);
  }, [currentView]);

  return {
    viewEntries,
    viewEntriesRef,
    currentView,
    setCurrentView,
    activeView,
    activeShell,
    visitedViews,
    viewNavDirection,
    currentViewRef,
    isSmallScreenRef,
    uiLabEnabled,
  };
}
