/** Fixed pre-change sidebar evidence. This does not read the refactored consumer. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

export const SIDEBAR_BASELINE = 'd3943bae5708e92f15f2a38de4510f72b2f77ae6';
export const SIDEBAR_PATH = 'src/features/settings/components/SettingsShellSidebar.tsx';
export const NAVIGATION_PATH = 'src/features/settings/components/useSettingsNavigation.tsx';

export interface SidebarInput {
  isMobile: boolean;
  isSmallScreen: boolean;
  globalLeftPanelCollapsed: boolean;
  externalSidebarControl: boolean;
  withBack: boolean;
}

export function legacySidebarEvidence() {
  const original = JSON.parse(fs.readFileSync('src/ui-plugins/official/settings/__golden__/settings.json', 'utf8'));
  const source = (file: string) => execFileSync('git', ['show', `${SIDEBAR_BASELINE}:${file}`], { encoding: 'utf8' });
  const sidebarSource = source(SIDEBAR_PATH);
  const navigationSource = source(NAVIGATION_PATH);
  const compile = (text: string) => ts.transpileModule(text, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  } }).outputText;
  const sidebarJs = compile(sidebarSource);
  const navigationJs = compile(navigationSource);
  const cases = [];
  for (const isMobile of [false, true]) for (const isSmallScreen of [false, true])
    for (const globalLeftPanelCollapsed of [false, true]) for (const externalSidebarControl of [false, true])
      for (const withBack of [false, true]) {
        const input: SidebarInput = { isMobile, isSmallScreen, globalLeftPanelCollapsed, externalSidebarControl, withBack };
        // The old consumer only uses state/memo and JSX. Evaluate those hooks synchronously,
        // invoking its actual forwarded callbacks; DOM interactions are separately tested in sidebar.test.tsx.
        const state: unknown[] = [];
        let hook = 0;
        let activeTab = 'apis';
        let backCalls = 0;
        const externalOpen: boolean[] = [];
        const react = {
          useMemo: (fn: () => unknown) => fn(),
          useState: (initial: unknown) => {
            const index = hook++;
            if (index >= state.length) state.push(initial);
            return [state[index], (next: unknown) => { state[index] = next; }];
          },
          createElement: (type: unknown, props: Record<string, any>) => ({ type, props }),
        };
        const require = (name: string): unknown => {
          if (name === 'react') return { ...react, default: react };
          if (name === 'react-i18next') return { useTranslation: () => ({ t: (key: string) => key }) };
          if (name === '@phosphor-icons/react') return new Proxy({}, { get: (_, key) => String(key) });
          if (name === '@/utils/platform') return { isMobilePlatform: () => isMobile };
          if (name === './SettingsSidebar') return { SettingsSidebar: 'SettingsSidebar' };
          if (name === '@/stores/settingsShellStore') return {
            useSettingsShellStore: (selector: (store: unknown) => unknown) => selector({
              activeTab, setActiveTab: (tab: string) => { activeTab = tab; },
            }),
          };
          if (name === './useSettingsNavigation') return navigation;
          throw new Error(`Unexpected baseline import: ${name}`);
        };
        const evaluate = (js: string) => {
          const exports: Record<string, any> = {};
          vm.runInNewContext(js, { exports, require });
          return exports;
        };
        const navigation = evaluate(navigationJs);
        const consumer = evaluate(sidebarJs).SettingsShellSidebar;
        const props = {
          isSmallScreen, globalLeftPanelCollapsed,
          ...(externalSidebarControl ? { setSidebarOpen: (open: boolean) => externalOpen.push(open) } : {}),
          ...(withBack ? { onBack: () => { backCalls++; } } : {}),
        };
        const render = () => { hook = 0; return consumer(props).props; };
        const snapshot = (forwarded: Record<string, any>) => {
          const nav = JSON.parse(JSON.stringify({ sidebarNavItems: forwarded.sidebarNavItems,
            sidebarCategories: forwarded.sidebarCategories, settingsSearchIndex: forwarded.settingsSearchIndex }));
          const expected = original.navigation[isMobile ? 'mobile' : 'desktop'];
          for (const key of Object.keys(nav)) assert.deepEqual(nav[key], expected[key]);
          return {
            isSmallScreen: forwarded.isSmallScreen, globalLeftPanelCollapsed: forwarded.globalLeftPanelCollapsed,
            desktopMode: forwarded.desktopMode, sidebarSearchQuery: forwarded.sidebarSearchQuery,
            sidebarSearchFocused: forwarded.sidebarSearchFocused, activeTab: forwarded.activeTab,
            hasBack: typeof forwarded.onBack === 'function', navigationRef: `settings.json#/navigation/${isMobile ? 'mobile' : 'desktop'}`,
          };
        };
        const forwarded = render();
        const initial = snapshot(forwarded);
        forwarded.setSidebarSearchQuery(' OCR ');
        forwarded.setSidebarSearchFocused(true);
        forwarded.setActiveTab('document-processing');
        forwarded.setSidebarOpen(true);
        forwarded.onBack?.();
        cases.push({ input, initial, afterActions: snapshot(render()), effects: { externalOpen, backCalls } });
      }
  return { baseline: SIDEBAR_BASELINE, consumer: { path: SIDEBAR_PATH, source: sidebarSource },
    navigation: { path: NAVIGATION_PATH, reference: 'settings.json#/navigation' }, cases };
}
