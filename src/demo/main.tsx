/**
 * Web 演示壳入口：纯浏览器运行**完整桌面版 App**。
 *
 * 与上一版（自制假壳 + 仅会话区真实组件）的差异：
 * 顶栏、侧边栏、命令面板等全部来自生产 App，mock 下沉到 IPC/事件层：
 * - mockIPC(shouldMockEvents:true) + mockWindows('main') 提供内存后端
 * - 剧本会话经 chat_v2_load_session restore 进真实 store
 * - 发送消息由 scriptPlayer 往真实 adapter 的 channel 推 BackendEvent 流
 *
 * 加载顺序至关重要：mock 必须先于任何 app 模块 import。
 *
 * 访问：http://127.0.0.1:1422/demo.html（?theme=dark 切暗色）
 */

import React from 'react';

// ① IPC/事件 mock（必须在任何 app 模块之前执行）
import { installDemoIpcMocks } from './mockIpc';
installDemoIpcMocks();

// 演示壳标记：App 据此隐藏开发版悬浮件（调试面板球 / 移动端恢复 FAB）
(window as unknown as { __DS_DEMO_SHELL__: boolean }).__DS_DEMO_SHELL__ = true;

// ② localStorage 预置（早于 App 模块级读取）
const params = new URLSearchParams(window.location.search);
const dark = params.get('theme') === 'dark';

// 主题：demo 默认亮色系，?theme=dark 切暗
localStorage.setItem('dstu-theme-mode', dark ? 'dark' : 'light');

// workbench 模式：demo 固定经典壳（含真实顶栏/侧边栏的桌面布局）。
// 该键与主 dev app 共享同源 localStorage，退出 demo 页时恢复原值，
// 避免污染桌面开发环境。
const WORKBENCH_KEY = 'desktop.workbenchMode';
const prevWorkbenchMode = localStorage.getItem(WORKBENCH_KEY);
localStorage.setItem(WORKBENCH_KEY, 'false');
window.addEventListener('beforeunload', () => {
  if (prevWorkbenchMode === null) {
    localStorage.removeItem(WORKBENCH_KEY);
  } else {
    localStorage.setItem(WORKBENCH_KEY, prevWorkbenchMode);
  }
});

// ③ 全局样式（与 App.tsx 同源）
import 'overlayscrollbars/overlayscrollbars.css';
import '../styles/tailwind.css';
import '../styles/shadcn-variables.css';
import '../styles/theme-colors.css';
import '../shared/styles/index.css';
import '../styles/ios-safe-area.css';
import '../styles/responsive-utilities.css';
import '../styles/typography.css';
import '../styles/shadcn-overrides.css';

// ④ i18n
import i18n from '../i18n';

async function main() {
  await i18n.changeLanguage('zh-CN');
  document.documentElement.lang = 'zh-CN';

  // ⑤ mock 就绪后再加载 app 组件树（与 src/main.tsx 的 appTree 同构）
  const [
    { default: App },
    { ErrorBoundary },
    { TopLevelFallback },
    { OverlayCoordinatorProvider },
    { DialogControlProvider },
    { installDemoAutoPlay },
    { dispatchAppEvent, APP_EVENTS },
    { DEMO_SESSIONS },
  ] = await Promise.all([
    import('../App'),
    import('../components/ErrorBoundary'),
    import('../components/TopLevelFallback'),
    import('../components/shared/OverlayCoordinator'),
    import('../contexts/DialogControlContext'),
    import('./autoPlay'),
    import('../events/app'),
    import('./fixtures'),
  ]);

  const { createRoot } = await import('react-dom/client');
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary
      name="TopLevel"
      fallback={(error: Error, componentStack?: string) => (
        <TopLevelFallback error={error} componentStack={componentStack} />
      )}
    >
      <OverlayCoordinatorProvider>
        <DialogControlProvider>
          <App />
        </DialogControlProvider>
      </OverlayCoordinatorProvider>
    </ErrorBoundary>,
  );

  // ⑤.5 自动播放：点进剧本会话即自动发问并流式播放回复（含初次自动导航）
  installDemoAutoPlay();

  // ⑥ ChatV2Page 完成首轮会话加载后，自动导航到第一个剧本会话。
  // sessions-updated 发出时 draft 会话的 setCurrentSessionId 尚未执行，
  // 因此再让出一拍，避免导航结果被 draft 选择覆盖。
  let navigated = false;
  const navigateToDemo = () => {
    if (navigated) return;
    navigated = true;
    dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_SESSION, { sessionId: DEMO_SESSIONS[0].meta.id });
  };
  window.addEventListener(
    'chat-v2:sessions-updated',
    () => setTimeout(navigateToDemo, 600),
    { once: true },
  );
  // 兜底：事件链路异常时也保证落到演示会话
  setTimeout(navigateToDemo, 4000);
}

void main();
