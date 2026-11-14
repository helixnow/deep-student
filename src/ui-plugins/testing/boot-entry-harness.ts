/** Execute the actual entry modules with inert UI/IPC boundaries, not a reimplementation of their branches. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { UiKernel } from '../../ui-kernel/kernel';
import { installOfficialUiPlugins } from '../official/install';

export interface BootCase {
  entry: 'main' | 'demo' | 'demo-app';
  search?: string;
  scenario?: string;
  tauri?: boolean;
  production?: boolean;
  strict?: boolean;
  width?: number;
}

export async function observeBoot(input: BootCase, onKernel?: (kernel: UiKernel) => void, onProvider?: (kernel: UiKernel) => void) {
  const trace: unknown[][] = [];
  const pendingTimers: (() => void)[] = [];
  const storage = new Map<string, string>();
  type Listener = (...args: unknown[]) => unknown;
  const listeners = new Map<string, Listener[]>();
  const node = { dataset: {}, innerHTML: '', appendChild(child: any) { trace.push(['message', child.textContent]); }, querySelector: () => null };
  class HTMLElement {}
  Object.setPrototypeOf(node, HTMLElement.prototype);
  const window: any = {
    location: { search: input.search ?? '', origin: 'https://demo.test', reload() {} },
    innerWidth: input.width ?? 1280,
    addEventListener(name: string, fn: Listener) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
    removeEventListener() {},
    __TAURI_INTERNALS__: input.tauri ? {} : undefined,
  };
  window.parent = window;
  const named = (name: string) => Object.assign(function () {}, { displayName: name });
  const react = {
    createElement(type: any, props: any, ...children: any[]) { return { type, props, children }; },
    StrictMode: 'StrictMode', Suspense: 'Suspense',
  };
  function tree(value: any): any {
    if (value == null || typeof value !== 'object') return value;
    if (value.type?.displayName === 'UiKernelProvider') {
      onProvider?.(value.props.kernel);
      return tree(value.children[0]);
    }
    return {
      type: typeof value.type === 'string' ? value.type : value.type?.displayName ?? value.type?.name,
      ...(value.props?.name ? { name: value.props.name } : {}),
      ...(value.props?.debugPreview ? { debugPreview: true } : {}),
      ...(value.props?.className ? { className: value.props.className } : {}),
      children: value.children.map(tree),
    };
  }
  const root = { render: (value: any) => trace.push(['render', tree(value)]) };
  const i18n = {
    addResourceBundle: (lng: string, ns: string) => trace.push(['locale', lng, ns]),
    changeLanguage: async (lng: string) => { trace.push(['language', lng]); },
  };
  const status = { recovery_required: input.scenario === 'recovery' };
  const health = input.scenario === 'blocked' ? [{ component: 'vfs', status: 'blocked' }] : [];
  const pack = {
    title: 'fixture', namespaces: ['fixture'],
    localStorage: { 'fixture.setting': 'yes' },
    prepare: async () => { trace.push(['pack.prepare']); },
    load: async () => { trace.push(['pack.load']); return named('FixtureApp'); },
  };
  const scenes = [{ meta: { id: 'scene-1' } }];
  const modules: Record<string, any> = {
    react: { default: react, ...react },
    'react-dom/client': { createRoot: () => root },
    overlayscrollbars: { OverlayScrollbars: { plugin() {} }, ClickScrollPlugin: {} },
    './lang': { demoLang: 'zh-CN' },
    '../lang': { tr: (zh: string) => zh },
    './mockIpc': { installDemoIpcMocks: (opts: any) => trace.push(['mocks', opts]) },
    './baseMocks': { installDemoAppMocks: () => trace.push(['mocks', 'pack']) },
    './locale': { loadDemoAppLocale: async () => { trace.push(['pack.locale']); } },
    './registry': { DEMO_APPS: [{ id: 'fixture', pack: async () => { trace.push(['pack']); return { default: pack }; } }] },
    './locales/zh-CN': { default: { common: {} } },
    './locales/en-US': { default: { common: {} } },
    './autoPlay': { installDemoAutoPlay: (options: any) => { trace.push(['autoplay', options]); return { activate() {}, continueScene() {} }; } },
    './fixtures': { DEMO_SESSIONS: scenes },
    './desktop': {
      prepareDemoDesktop: () => trace.push(['desktop.prepare']),
      arrangeDemoDesktop: async () => { trace.push(['desktop.arrange']); },
    },
    './reactRoot': { getOrCreateReactRoot: () => root },
    './utils/platform': { initPlatformClasses() {} },
    './features/workbench/core/materialTier': { getMaterialTier() {} },
    './utils/chatV2DomainEventBridge': { installChatV2DomainEventBridge() {} },
    './logging/errorReporter': { installGlobalErrorReporter: () => () => {}, reportFrontendError: async () => {}, serializeUnknown: (v: any) => v },
    './dstu': { setDstuLogger() {}, createLoggerFromDebugPlugin() {} },
    './debug-panel/debugMasterSwitch': { debugMasterSwitch: { isEnabled: () => false, addListener: () => () => {} }, debugLog: { warn() {} } },
    './mcp/mcpService': { McpService: { dispose() {} }, bootstrapMcpFromSettings: async () => { trace.push(['runtime.mcp']); } },
    './hooks/useAppInitialization': { initializeFontSetting: async () => { trace.push(['font']); } },
    './features/data-recovery/dataRecoveryApi': {
      getStartupRecoveryStatus: async () => { trace.push(['preflight']); return status; },
    },
    './api/dataGovernance': { getMaintenanceStatus: async () => { trace.push(['maintenance']); return { component_health: { components: health } }; } },
    './stores/systemStatusStore': { useSystemStatusStore: { getState: () => ({ setComponentHealth() {} }) } },
    './features/data-recovery/debugRecoveryScenarios': {
      getRecoveryDebugScenario: () => input.scenario?.startsWith('debug:') ? input.scenario.slice(6) : null,
      clearRecoveryDebugScenario() {},
      createStartupConflictDebugStatus: () => ({}),
      createStartupPreflightFailureDebugStatus: () => ({}),
      createCoreMigrationFailureDebugIssues: () => [],
    },
    '@tauri-apps/api/core': { invoke: async (cmd: string) => { trace.push(['invoke', cmd]); return null; } },
    './quick-assistant/window': { initializeQuickAssistantGlobalShortcut: async () => () => {}, initializeQuickAssistantMainBridge: async () => () => {} },
    './features/study-time/studyTimeTracker': { startStudyTracking: () => { trace.push(['study']); return () => {}; } },
  };
  const entry = input.entry === 'main' ? 'src/main.tsx' : input.entry === 'demo' ? 'src/demo/main.tsx' : 'src/demo/app/main.tsx';
  const source = fs.readFileSync(path.resolve(entry), 'utf8').replace(/import\.meta/g, '__importMeta');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const requireModule = (id: string) => {
    if (/\/ui-kernel\/bootstrap$/.test(id)) {
      // Execute the real production assembly with inert registry/IPC boundaries.
      const exports: any = {};
      const bootstrap = ts.transpileModule(fs.readFileSync(path.resolve('src/ui-kernel/bootstrap.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const dependencies: Record<string, any> = {
        './kernel': { UiKernel },
        '../ui-plugins/official/install': { installOfficialUiPlugins },
        '../i18n': { default: i18n },
        '../command-palette/registry/commandRegistry': { commandRegistry: { register: () => () => {}, getById: () => undefined } },
        '../features/chat/registry/blockRegistry': { blockRegistry: { has: () => false } },
        '../features/workbench/core/appRegistry': { appRegistry: { get: () => undefined } },
        '@tauri-apps/api/core': modules['@tauri-apps/api/core'],
      };
      vm.runInNewContext(bootstrap, { exports, require: (key: string) => dependencies[key] });
      return { createAppUiKernel: async () => { const kernel = await exports.createAppUiKernel(); onKernel?.(kernel); return kernel; } };
    }
    if (/\/ui-kernel\/react$/.test(id)) return { UiKernelProvider: named('UiKernelProvider') };
    if (/\/ui-kernel\/community$/.test(id)) return { startCommunityUiPlugins: async () => async () => {} };
    trace.push(['import', id, Boolean(window.__DS_DEMO_SHELL__)]);
    if (modules[id]) return modules[id];
    if (/\/i18n$/.test(id)) return { default: i18n };
    if (/pendingChatNavigation$/.test(id)) return { requestChatSessionNavigation: (scene: string) => trace.push(['navigate', scene]) };
    if (/sessionManager$/.test(id)) return { sessionManager: { getCurrentSessionId: () => null } };
    if (/\/useTheme$/.test(id)) return { useTheme() {} };
    return new Proxy({}, { get: (_target, key) => key === 'then' ? undefined : key === '__esModule' ? true : named(key === 'default' ? id.split('/').pop()! : String(key)) });
  };
  const context = vm.createContext({
    require: requireModule, exports: {}, window, HTMLElement,
    __importMeta: { env: { MODE: input.production ? 'production' : 'development', VITE_ENABLE_STRICT_MODE: input.strict ? 'true' : 'false', DEV: !input.production } },
    document: {
      getElementById: () => node, createElement: () => ({ className: '', textContent: '' }),
      documentElement: { classList: { toggle() {} }, setAttribute() {}, dataset: {} },
      addEventListener() {}, removeEventListener() {},
    },
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); trace.push(['storage', k, v]); },
      removeItem: (k: string) => storage.delete(k),
    },
    URLSearchParams, console: { log() {}, warn() {}, error: (...args: any[]) => trace.push(['error', String(args[0])]) },
    setTimeout: (fn: () => void) => { pendingTimers.push(fn); return pendingTimers.length; },
    clearTimeout() {}, Date: input.scenario === 'preflight-error' ? class extends Date { static now() { return (this as any).clock = ((this as any).clock ?? 0) + 140000; } } : Date,
  });
  vm.runInContext(compiled, context, { filename: entry });
  for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  return JSON.parse(JSON.stringify({ trace, demo: Boolean(window.__DS_DEMO_SHELL__) }));
}
