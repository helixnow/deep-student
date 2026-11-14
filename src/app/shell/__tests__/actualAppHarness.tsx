/** Executes the actual App module and its assembly modules, not a copied JSX tree.
 * Native/background services and business pages are isolated leaves. The exact same
 * isolation is used with git blobs at e73e0d98 and the working source.
 */
import React from 'react';
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as kernelReact from '@/ui-kernel/react';
import * as events from '@/events';
import * as viewState from '@/utils/viewStateManager';
import * as shellView from '@/ui-kernel/shell-view';
import { ViewLayerRenderer } from '@/app/components/ViewLayerRenderer';

const noop = () => undefined;
const pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
const t = (key: string) => key;
const i18n = { changeLanguage: noop, language: 'en-US' };

export function actualAppHarness(options: { revision?: string; small?: boolean; workbench?: boolean } = {}) {
  const cache = new Map<string, any>();
  const executed: string[] = [];
  const startup: string[] = [];
  let navigate: (view: string) => void = noop;
  const state = { leftPanelCollapsed: false, leftPanelWidth: 260 };
  const store = Object.assign((select: any) => select(state), { getState: () => ({ ...state, toggleLeftPanel: noop }), setState: noop });
  const system = { maintenanceMode: false, maintenanceReason: '', maintenanceRequiresRestart: false, componentHealth: [] };
  const sessionManager = { getCurrentSessionId: () => null, get: () => null, subscribe: () => noop };
  const page = (name: string) => function Page() { return <div data-page={name} />; };
  const lazyPages = new Proxy({}, { get: (_, name) => name === '__esModule' ? true : page(String(name)) });
  const leaf = new Proxy({ __esModule: true }, { get: (_, key) => {
    if (key === '__esModule') return true;
    if (/Provider$/.test(String(key))) return pass;
    if (/^[A-Z]/.test(String(key))) return () => null;
    return noop;
  } });
  const real = new Set([
    'src/App.tsx', 'src/app/hooks/useViewLayerContents.tsx',
    'src/app/hooks/useViewScrollRestoration.ts', 'src/app/navigation/viewRouting.ts',
    'src/app/navigation/cardsHub.ts',
    'src/app/shell/AppShellChrome.tsx', 'src/app/shell/useViewLayer.tsx',
    'src/app/shell/useAppViewState.ts', 'src/app/shell/useAppNavigation.ts',
    'src/app/shell/useDesktopSidebarLayout.ts', 'src/app/shell/useChatHeaderSession.ts',
    'src/app/shell/desktopShell.ts', 'src/app/shell/mobileShell.ts',
    'src/config/mobileLayout.ts', 'src/config/breakpoints.ts',
    'src/ui-plugins/official/shell/RegisteredViewLayer.tsx',
  ]);
  function load(id: string): any {
    if (cache.has(id)) return cache.get(id);
    const read = () => options.revision
      ? execFileSync('git', ['show', `${options.revision}:${id}`], { encoding: 'utf8' })
      : fs.readFileSync(id, 'utf8');
    if (real.has(id)) {
      const module = { exports: {} };
      cache.set(id, module.exports);
      executed.push(id);
      const source = read().replaceAll('import.meta.env.DEV', 'true').replaceAll('import.meta.env.VITE_DS_PLATFORM', '"mobile"');
      const js = ts.transpileModule(source, { fileName: id, compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React, esModuleInterop: true,
      } }).outputText;
      Function('require', 'module', 'exports', 'React', js)((spec: string) => {
        const target = spec.startsWith('@/') ? `src/${spec.slice(2)}` : spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(id), spec)) : spec;
        const resolved = [...real].find(file => file.replace(/\.tsx?$/, '') === target);
        return load(resolved ?? target);
      }, module, module.exports, React);
      return module.exports;
    }
    if (id === 'react') return React;
    if (id === 'src/app/workbench/load') return { loadWorkbenchHost: () => { startup.push('host'); return Promise.resolve(); } };
    if (id === 'src/app/workbench/lazyDesktop') return { prewarmWorkbenchDesktop: () => startup.push('prewarm'), LazyAgentBridge: () => null, LazyWorkbenchDesktop: page('WorkbenchDesktop') };
    if (id === 'src/ui-kernel/react') return kernelReact;
    if (id === 'src/ui-kernel/shell-view') return shellView;
    if (id === 'src/events') return events;
    if (id === 'src/utils/viewStateManager') return viewState;
    if (id === 'src/app/components/ViewLayerRenderer') return { ViewLayerRenderer };
    if (id === 'react-i18next') return { useTranslation: () => ({ t, i18n }) };
    if (id === 'src/lazyComponents') return lazyPages;
    if (id === 'src/features/anki-tasks/AnkiTasksApp') return { AnkiTasksApp: page('AnkiTasksApp') };
    if (id === 'src/features/settings/components/CloudStorageSection') return { CloudStorageSection: () => null };
    if (id === 'src/stores/uiStore') return { useUIStore: store };
    if (id === 'src/stores/systemStatusStore') return { useSystemStatusStore: (fn: any) => fn(system) };
    if (id === 'src/stores/viewStore') return { useViewStore: { getState: () => ({ setCurrentView: noop }) } };
    if (id === 'src/utils/platform') return { isMacOS: () => false, isWindows: () => false, isMobilePlatform: () => Boolean(options.small) };
    if (id === 'src/hooks/useBreakpoint') return { useBreakpoint: () => ({ isSmallScreen: Boolean(options.small) }) };
    if (id === 'src/components/legal/UserAgreementDialog') return { useUserAgreement: () => ({ needsAgreement: false, checkAgreement: noop, acceptAgreement: noop }) };
    if (id === 'src/components/onboarding/WelcomeOnboardingDialog') return { useWelcomeOnboarding: () => ({ open: false, dismiss: noop }) };
    if (id === 'src/hooks/useTheme') return { __esModule: true, default: () => ({ isDarkMode: false, toggleDarkMode: noop }) };
    if (id === 'src/app/hooks/useWorkbenchMode') return { useWorkbenchMode: () => ({ workbenchActive: Boolean(options.workbench) }), WORKBENCH_MODE_CACHE_KEY: 'workbench-test' };
    if (id === 'src/app/hooks/usePlatformSettingsSync') return { usePlatformSettingsSync: () => ({ topbarTopMargin: 0 }) };
    if (id === 'src/app/hooks/useDebugPanelRequests') return { useDebugPanelRequests: () => ({ debugPanelRequested: false, debugPanelOpenRequest: 0 }) };
    if (id === 'src/app/hooks/useViewRedirects') return { useViewRedirects: () => ({ uiLabEnabled: true }) };
    if (id === 'src/app/hooks/useUnifiedNavigation') return { useUnifiedNavigation: () => ({ navigationHistory: { clear: noop }, unifiedCanGoBack: false, unifiedCanGoForward: false, unifiedGoBack: noop, unifiedGoForward: noop }) };
    if (id === 'src/app/hooks/useDesktopTitlebarInteractions') return { useDesktopTitlebarInteractions: () => ({ navigationShortcuts: {}, commandPaletteTriggerRef: { current: null } }) };
    if (id === 'src/app/hooks/useDesktopWindowMaximizeToggle') return { useDesktopWindowMaximizeToggle: () => ({ toggleDesktopWindowMaximize: noop }) };
    if (id === 'src/app/hooks/useShellNavigationEvents') return { useShellNavigationEvents: () => ({ openInLearningHub: noop }) };
    if (id === 'src/app/hooks/useDesktopSidebarElements') return { useDesktopSidebarElements: () => ({ sidebarElement: null, settingsShellSidebarElement: null, todoShellSidebarElement: null }) };
    if (id === 'src/hooks/useWindowDrag') return { useWindowDrag: () => ({ startDragging: noop }) };
    if (id === 'src/hooks/useAndroidSafeArea') return { useAndroidSafeArea: () => ({ top: 0 }) };
    if (id === 'src/contexts/DialogControlContext') return { useDialogControl: () => ({}) };
    if (id === 'src/command-palette/CommandPaletteProvider') return {
      CommandPaletteProvider: ({ children, navigate: fn }: any) => { navigate = fn; return children; },
      useCommandPalette: () => ({ open: noop }),
    };
    if (id === 'src/command-palette/hooks/useCommandEvents') return { useCommandEvents: noop, COMMAND_EVENTS: {} };
    if (id === 'src/debug-panel/debugMasterSwitch') return { debugLog: console };
    if (id === 'src/debug-panel/services/pageLifecycleTracker') return { pageLifecycleTracker: { isEnabled: () => false, log: noop } };
    if (id === 'src/features/chat/core/session/sessionManager') return { sessionManager };
    if (id === 'src/features/chat/core/store/groupCache') return { groupCache: new Map() };
    if (id === 'src/utils/sidebarTranslucency') return { syncNativeWindowAppearance: noop, clearNativeTitlebarSidebarMaterial: noop };
    if (id === 'src/utils/pendingSettingsTab') return { setPendingSettingsTab: noop, setPendingSettingsRoute: noop };
    if (id === 'src/features/workbench/core/workbenchBus') return { workbenchBus: { isEnabled: () => Boolean(options.workbench) } };
    if (id === 'src/ui-plugins/official/shell/navigation') return { resolveShellView: (view: string) => view };
    if (id === 'src/components/layout') return new Proxy({ MobilePageScaffold: ({ children }: any) => <div data-scaffold="mobile">{children}</div> }, { get: (target, key) => (target as any)[key] ?? pass });
    if (id === 'src/components/custom-scroll-area') return { CustomScrollArea: pass };
    if (id === 'src/lib/utils') return { cn: (...args: any[]) => args.filter(Boolean).join(' ') };
    if (id === 'src/config/zIndex') return { Z_INDEX: {} };
    if (id === '@tauri-apps/api/core') return { invoke: async () => undefined };
    return leaf;
  }
  const App = load('src/App.tsx').default;
  return { App, executed, startup, navigate: (view: string) => navigate(view) };
}
