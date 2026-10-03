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
import './demo.css';

// ④ i18n
import i18n from '../i18n';

/** 剧本会话迟迟没上屏时，最多等这么久也照样通知父页撤占位 */
const READY_FALLBACK_MS = 10000;

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
    { requestChatSessionNavigation },
    { sessionManager },
    { DEMO_SESSIONS },
  ] = await Promise.all([
    import('../App'),
    import('../components/ErrorBoundary'),
    import('../components/TopLevelFallback'),
    import('../components/shared/OverlayCoordinator'),
    import('../contexts/DialogControlContext'),
    import('./autoPlay'),
    import('../features/chat/navigation/pendingChatNavigation'),
    import('../features/chat/core/session/sessionManager'),
    import('./fixtures'),
  ]);

  const validSceneIds = new Set(DEMO_SESSIONS.map((session) => session.meta.id));
  const requestedScene = params.get('scene');
  const initialScene = requestedScene && validSceneIds.has(requestedScene)
    ? requestedScene
    : DEMO_SESSIONS[0]?.meta.id;

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

  // 通知 hero 落地页撤下"演示加载中"占位：等剧本会话真正成为当前会话、
  // 历史加载完毕再发，早发会让占位撤掉后露出启动画面和 draft 的空白聊天区。
  // 轮询用 setTimeout 而非 rAF：rAF 在离屏 iframe（演示窗被平移出视口/未滚到）
  // 会被浏览器节流甚至暂停，回调可能永不执行。hero 侧另有 15s 超时兜底。
  if (window.parent !== window) {
    const readyDeadline = Date.now() + READY_FALLBACK_MS;
    const notifyWhenSceneShown = () => {
      const currentId = sessionManager.getCurrentSessionId();
      const shown = !!currentId && validSceneIds.has(currentId) &&
        !!sessionManager.peek(currentId)?.getState().isDataLoaded;
      if (shown || Date.now() > readyDeadline) {
        window.parent.postMessage({ type: 'demo-shell-ready' }, window.location.origin);
        return;
      }
      setTimeout(notifyWhenSceneShown, 100);
    };
    notifyWhenSceneShown();
  }

  // ⑤.5 自动播放：直接打开 demo 时立即播放；被 hero iframe 嵌入时等待父页
  // 进入视口后发 demo:activate，避免用户尚未看到体验区就开始消耗剧本。
  const autoPlay = installDemoAutoPlay({ waitForActivation: window.parent !== window });

  // hero 与 demo 同源时才接受控制消息，避免任意嵌入页面驱动会话。
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || event.source !== window.parent || !event.data) return;
    const data = event.data as { type?: string; sessionId?: unknown; continuationId?: unknown };
    if (data.type === 'demo:activate') {
      autoPlay.activate();
      return;
    }
    if (data.type === 'demo:download-materials') {
      void import('./materials').then(({ downloadDemoMaterials }) => downloadDemoMaterials())
        .then(() => window.parent.postMessage({ type: 'demo:materials-result', ok: true }, window.location.origin))
        .catch(() => window.parent.postMessage({ type: 'demo:materials-result', ok: false }, window.location.origin));
      return;
    }
    if (data.type === 'demo:continue' && typeof data.sessionId === 'string' && typeof data.continuationId === 'string') {
      autoPlay.continueScene(data.sessionId, data.continuationId);
      return;
    }
    if (data.type !== 'demo:set-scene' || typeof data.sessionId !== 'string') return;
    if (!validSceneIds.has(data.sessionId)) return;
    requestChatSessionNavigation(data.sessionId);
  });

  // ⑥ 打开剧本会话走生产的导航握手：ChatV2Page 初始加载会把当前会话设成
  // 启动 draft，并忽略加载期间到达的导航事件；握手把意图挂起，加载完成后重放。
  if (initialScene) requestChatSessionNavigation(initialScene);
}

void main();
