/**
 * 单应用演示入口：demo-app.html?app=<章节 slug>[&theme=dark][&lang=en]
 *
 * 官网每一章用户指南嵌一个只含该功能的演示。与 demo.html 的区别：不加载 App 壳，
 * 只渲染这一个应用的窗口组件（与学习桌面里开出的窗口同一份生产代码），数据来自
 * 该章的剧本包（./packs/<id>）。页面只下载这一个包和它用到的应用代码。
 *
 * 加载顺序：剧本包 → IPC mock → 文案 → 应用代码。剧本包和 mock 的静态依赖链
 * 不能触达 app 模块（见 ./types.ts）。
 */
import React from 'react';
import { tr } from '../lang';
import { DEMO_APPS } from './registry';
import { installDemoAppMocks } from './baseMocks';
import { loadDemoAppLocale } from './locale';

import 'overlayscrollbars/overlayscrollbars.css';
import '../../styles/tailwind.css';
import '../../styles/shadcn-variables.css';
import '../../styles/theme-colors.css';
import '../../shared/styles/index.css';
import '../../styles/typography.css';
import '../../styles/shadcn-overrides.css';
import './app.css';

import i18n from '../../i18n';

const params = new URLSearchParams(window.location.search);
const dark = params.get('theme') === 'dark';
const appId = params.get('app') ?? '';

(window as unknown as { __DS_DEMO_SHELL__: boolean }).__DS_DEMO_SHELL__ = true;
// 官网里的演示一律当作访客已拒绝通知权限（同 demo.html）
Object.defineProperty(window, 'Notification', {
  configurable: true,
  writable: true,
  value: Object.assign(function DemoNotification() {}, {
    permission: 'denied' as NotificationPermission,
    requestPermission: async (): Promise<NotificationPermission> => 'denied',
  }),
});

function notifyParent(type: string): void {
  if (window.parent !== window) window.parent.postMessage({ type, app: appId }, '*');
}

function showMessage(text: string): void {
  const root = document.getElementById('root')!;
  root.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'demo-app-message';
  p.textContent = text;
  root.appendChild(p);
}

async function main() {
  const entry = DEMO_APPS.find((app) => app.id === appId);
  if (!entry) {
    showMessage(tr(`没有名为「${appId}」的演示。`, `There is no demo named "${appId}".`));
    return;
  }
  const { default: pack } = await entry.pack();

  // localStorage 预置要早于应用模块级预读；主题键也在这里
  try {
    localStorage.setItem('dstu-theme-mode', dark ? 'dark' : 'light');
    for (const [key, value] of Object.entries(pack.localStorage ?? {})) localStorage.setItem(key, value);
  } catch {
    /* 隐私模式下写不进去也照样能跑 */
  }
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.title = `Deep Student · ${pack.title}`;

  installDemoAppMocks(pack);
  await loadDemoAppLocale(i18n, pack.namespaces);
  await pack.prepare?.();

  const [
    Component,
    { ErrorBoundary },
    { OverlayCoordinatorProvider },
    { DialogControlProvider },
    { TextContextMenuProvider },
    { useTheme },
    { createRoot },
  ] = await Promise.all([
    pack.load(),
    import('../../components/ErrorBoundary'),
    import('../../components/shared/OverlayCoordinator'),
    import('../../contexts/DialogControlContext'),
    import('../../components/context-menu/TextContextMenu'),
    import('../../hooks/useTheme'),
    import('react-dom/client'),
  ]);

  const ThemeSync: React.FC = () => {
    useTheme();
    return null;
  };

  const rootEl = document.getElementById('root')!;
  rootEl.dataset.demoApp = appId;
  createRoot(rootEl).render(
    <ErrorBoundary
      name="DemoApp"
      fallback={() => (
        <p className="demo-app-message" data-demo-error>
          {tr('演示加载出错，请刷新页面重试。', 'The demo failed to load. Please reload the page.')}
        </p>
      )}
    >
      <OverlayCoordinatorProvider>
        <DialogControlProvider>
          <TextContextMenuProvider>
            <ThemeSync />
            <div className="demo-app-frame" data-demo-app-frame>
              <React.Suspense fallback={null}>
                <Component
                  windowId={`demo-${appId}`}
                  instanceKey={pack.instanceKey ?? null}
                  launchPayload={pack.launchPayload ?? null}
                  isActive
                  isVisible
                  renderThrottleMs={0}
                  isSuspended={false}
                  onTitleChange={() => {}}
                  requestClose={() => {}}
                />
              </React.Suspense>
            </div>
          </TextContextMenuProvider>
        </DialogControlProvider>
      </OverlayCoordinatorProvider>
    </ErrorBoundary>,
  );

  // 就绪：包自己的判断，缺省是界面连续 600ms 没有变化。最多等 12s 照样通知（父页另有兜底）
  const deadline = Date.now() + 12_000;
  let lastSignature = '';
  let stableSince = Date.now();
  let mounted = false;
  const check = async () => {
    const frame = rootEl.querySelector<HTMLElement>('[data-demo-app-frame]');
    const signature = frame ? `${frame.innerHTML.length}` : '';
    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = Date.now();
    }
    const hasContent = Boolean(frame && frame.textContent && frame.textContent.trim().length > 0);
    if (hasContent && !mounted) {
      mounted = true;
      await pack.afterMount?.(rootEl);
    }
    const ready = mounted && (pack.isReady ? pack.isReady(rootEl) : Date.now() - stableSince > 600);
    if (ready || Date.now() > deadline) {
      window.__DEMO_READY__ = true;
      document.documentElement.dataset.demoReady = 'true';
      notifyParent('demo-app-ready');
      return;
    }
    // setTimeout 而非 rAF：离屏 iframe 里 rAF 会被暂停
    setTimeout(() => void check(), 100);
  };
  void check();
}

void main().catch((error) => {
  console.error('[demo-app] failed to start', error);
  showMessage(tr('演示加载出错，请刷新页面重试。', 'The demo failed to load. Please reload the page.'));
  notifyParent('demo-app-error');
});

