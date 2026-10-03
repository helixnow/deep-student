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
 * 访问：http://127.0.0.1:1422/demo.html（?theme=dark 切暗色，?desktop=1 开学习桌面，?lang=en 英文界面）
 */

import React from 'react';
import { demoLang } from './lang';

const params = new URLSearchParams(window.location.search);
const dark = params.get('theme') === 'dark';
/** 学习桌面（桌面端的默认界面）；缺省是经典布局，首屏 hero 演示用的就是它 */
const desktop = params.get('desktop') === '1';

// ① IPC/事件 mock（必须在任何 app 模块之前执行）
import { installDemoIpcMocks } from './mockIpc';
installDemoIpcMocks({ desktop, dark });

// 演示壳标记：App 据此隐藏开发版悬浮件（调试面板球 / 移动端恢复 FAB）
(window as unknown as { __DS_DEMO_SHELL__: boolean }).__DS_DEMO_SHELL__ = true;

// 系统通知在浏览器里落到 Web Notification：到点提醒、早间汇总、制卡完成都会向访客要「显示通知」权限，
// 同意了还会弹出演示数据的系统通知。官网里的演示一律当作访客已拒绝，权限框不出现
Object.defineProperty(window, 'Notification', {
  configurable: true,
  writable: true,
  value: Object.assign(function DemoNotification() {}, {
    permission: 'denied' as NotificationPermission,
    requestPermission: async (): Promise<NotificationPermission> => 'denied',
  }),
});

// 这两处功能还没进正式版，演示里不露出：对话首页的「今日待复习」、闪卡库的「导出 .apkg」
const hideUnreleased = document.createElement('style');
hideUnreleased.textContent = '[data-testid="today-review-hint"],[data-testid="fc-lib-export-apkg"]{display:none!important}';
document.head.appendChild(hideUnreleased);

// 界面文案整包：只取当前语言那一块，和后面的 App 代码并行下载
const localeBundle = demoLang === 'en-US' ? import('./locales/en-US') : import('./locales/zh-CN');

// ② localStorage 预置（早于 App 模块级读取）

// 主题：demo 默认亮色系，?theme=dark 切暗
localStorage.setItem('dstu-theme-mode', dark ? 'dark' : 'light');

// workbench 模式：经典壳（含真实顶栏/侧边栏的桌面布局）还是学习桌面，由入口参数定。
// 这里只是 App 模块级预读的缓存，最终以 mock 设置表里的同名键为准——
// 官网同一页里两个演示 iframe 共用 localStorage，互相覆盖也不会开错壳。
// 该键与主 dev app 共享同源 localStorage，退出 demo 页时恢复原值，
// 避免污染桌面开发环境。
const WORKBENCH_KEY = 'desktop.workbenchMode';
const prevWorkbenchMode = localStorage.getItem(WORKBENCH_KEY);
localStorage.setItem(WORKBENCH_KEY, desktop ? 'true' : 'false');
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

/** 剧本会话迟迟没上屏时，最多等这么久也照样通知父页撤占位（学习桌面还要等开窗和首答落定） */
const READY_FALLBACK_MS = desktop ? 15000 : 10000;

async function main() {
  // 学习桌面开场要的窗口代码都是懒加载的：桌面挂上才拉对话窗口、对话窗口挂上才拉会话页，一层等一层。
  // 演示构建不给动态导入加预载，这里和 App 并行先拉（只取模块，不渲染）
  if (desktop) {
    void Promise.all([
      import('../features/workbench/components/WorkbenchDesktop'),
      import('../features/workbench/apps/chat/ChatAppWindow'),
      import('../features/chat/pages'),
      import('../features/workbench/apps/system/FlashcardsAppWindow'),
    ]).catch(() => { /* 真用到时还会再拉一次 */ });
  }

  const { default: bundles } = await localeBundle;
  for (const [ns, resources] of Object.entries(bundles)) {
    i18n.addResourceBundle(demoLang, ns, resources, true, true);
  }
  await i18n.changeLanguage(demoLang);
  document.documentElement.lang = demoLang;

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

  const desktopShell = desktop ? await import('./desktop') : null;
  desktopShell?.prepareDemoDesktop();

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

  // 学习桌面：等桌面挂上再开窗，窗口位置按桌面实际尺寸算
  let arranged = !desktopShell;
  if (desktopShell && initialScene) {
    void desktopShell.arrangeDemoDesktop(initialScene).finally(() => {
      arranged = true;
    });
  }

  // 通知 hero 落地页撤下"演示加载中"占位：等剧本会话真正成为当前会话、
  // 历史加载完毕再发，早发会让占位撤掉后露出启动画面和 draft 的空白聊天区。
  // 学习桌面的首答是瞬时播完的，再等它落定：海报拍的就是这个完成态。
  // 轮询用 setTimeout 而非 rAF：rAF 在离屏 iframe（演示窗被平移出视口/未滚到）
  // 会被浏览器节流甚至暂停，回调可能永不执行。hero 侧另有 15s 超时兜底。
  const sceneShown = () => {
    const currentId = sessionManager.getCurrentSessionId();
    const state = currentId && validSceneIds.has(currentId)
      ? sessionManager.peek(currentId)?.getState()
      : undefined;
    if (!state?.isDataLoaded) return false;
    if (!desktopShell) return true;
    return arranged && state.sessionStatus === 'idle' && [...state.messageMap.values()].some(
      (m) => m.role === 'assistant' && m.blockIds.some((id) => state.blocks.get(id)?.status === 'success'),
    );
  };
  if (window.parent !== window) {
    const readyDeadline = Date.now() + READY_FALLBACK_MS;
    const notifyWhenSceneShown = () => {
      if (sceneShown() || Date.now() > readyDeadline) {
        window.parent.postMessage({ type: 'demo-shell-ready' }, window.location.origin);
        return;
      }
      setTimeout(notifyWhenSceneShown, 50);
    };
    notifyWhenSceneShown();
  }

  // ⑤.5 自动播放：直接打开 demo 时立即播放；被 hero iframe 嵌入时等待父页
  // 进入视口后发 demo:activate，避免用户尚未看到体验区就开始消耗剧本。
  // 学习桌面不演打字：首答瞬时播完，海报撤下时对话窗口已经是完成态。
  const autoPlay = installDemoAutoPlay(
    desktopShell
      ? { instantFirstPlay: true }
      : { waitForActivation: window.parent !== window },
  );

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
