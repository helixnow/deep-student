import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import React from 'react';
import ts from 'typescript';

export const LEGACY_REVISION = 'e303957124ac220f55bee1b04cca5d3937983b92';

/** W38: 壳层 chrome 已搬出 App.tsx；源码证据要在两处一起找。 */
export const SHELL_CHROME_SOURCE = 'src/app/shell/AppShellChrome.tsx';
export const VIEW_LAYER_SOURCE = 'src/app/shell/useViewLayer.tsx';
export const VIEW_STATE_SOURCE = 'src/app/shell/useAppViewState.ts';
export const NAVIGATION_SOURCE = 'src/app/shell/useAppNavigation.ts';

/** App 壳层源码（App.tsx + 搬出的 chrome）；传 revision 时读该提交的 App.tsx（当时尚未拆分）。 */
export function readAppShellSource(revision?: string): ts.SourceFile {
  const read = (path: string) => (revision
    ? execFileSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8' })
    : fs.readFileSync(path, 'utf8'));
  const text = revision ? read('src/App.tsx') : `${read('src/App.tsx')}\n${read(SHELL_CHROME_SOURCE)}\n${read(VIEW_LAYER_SOURCE)}\n${read(VIEW_STATE_SOURCE)}\n${read(NAVIGATION_SOURCE)}`;
  return ts.createSourceFile('src/App.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

export function readSource(path: string, revision?: string) {
  const text = revision ? execFileSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8' }) : fs.readFileSync(path, 'utf8');
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

export function declaration(file: ts.SourceFile, name: string): ts.Expression {
  return findNode(file, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText(file) === name).initializer!;
}

export function findNode<T extends ts.Node>(file: ts.SourceFile, match: (node: ts.Node) => node is T): T {
  let found: T | undefined;
  function visit(node: ts.Node) {
    if (!found && match(node)) found = node;
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!found) throw new Error(`Missing consumer expression in ${file.fileName}`);
  return found;
}

// Execute the exact source expressions, including JSX and navigation callbacks.
// Only environmental hooks/side effects are supplied; there is no copied gate,
// header or canonicalization algorithm in this harness.
type CompiledExpression = (...args: unknown[]) => unknown;
const compiled = new Map<string, CompiledExpression>();
export function evaluate(text: string, scope: Record<string, unknown>) {
  const keys = Object.keys(scope);
  const key = JSON.stringify([text, keys]);
  let fn = compiled.get(key);
  if (!fn) {
    const js = ts.transpileModule(`const result = (${text.replaceAll('import.meta.env.DEV', 'envDev')});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
    }).outputText;
    fn = Function(...keys, `${js}; return result;`) as CompiledExpression;
    compiled.set(key, fn);
  }
  return fn(...Object.values(scope));
}

export function consumerEvidence(revision?: string, officialViewIds?: ReadonlySet<string>) {
  const app = readAppShellSource(revision);
  const canonical = readSource('src/app/navigation/canonicalView.ts', revision);
  const old = Boolean(revision);
  const jsxCondition = (marker: string) => findNode(app, (node): node is ts.ConditionalExpression =>
    ts.isConditionalExpression(node) && node.whenTrue.getText(app).includes(marker) &&
    (marker !== '<DesktopShellTitleEditor' || node.condition.getText(app).includes('currentChatHeaderSessionId')));
  const toolbar = jsxCondition('ref={setDesktopPageHeaderTarget}');
  const chat = jsxCondition('<DesktopShellTitleEditor');
  const sidebar = jsxCondition('<DesktopShellSidebarLayers');
  const workspace = findNode(app, (node): node is ts.ConditionalExpression =>
    ts.isConditionalExpression(node) && node.condition.getText(app) === 'workbenchActive' && node.whenTrue.getText(app).includes('<LazyWorkbenchDesktop'));
  const slot = findNode(app, (node): node is ts.JsxAttribute =>
    ts.isJsxAttribute(node) && node.name.getText(app) === 'data-shell-slot' && Boolean(node.initializer && ts.isJsxExpression(node.initializer)));
  const slotExpression = (slot.initializer as ts.JsxExpression).expression!.getText(app);
  const get = (name: string, scope: Record<string, unknown>) => evaluate(declaration(app, name).getText(app), scope);
  const base = { React, useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn() };

  function active(currentView: string, entries: readonly any[]) {
    if (old) return { ...base, currentView };
    const scope = { ...base, currentView, viewEntries: entries };
    const activeView = get('activeView', scope);
    return { ...scope, activeView, activeShell: get('activeShell', { ...scope, activeView }) };
  }

  return {
    chrome(id: string, entries: readonly any[], leftPanelCollapsed: boolean, unifiedCanGoBack = false) {
      const scope = { ...active(id, entries), leftPanelCollapsed, unifiedCanGoBack };
      return {
        sidebarToggle: get('shouldShowDesktopSidebarToggle', scope),
        headerNav: get('shouldShowDesktopHeaderNavControls', scope),
        mobileBack: get('mobileHeaderCanGoBack', scope),
      };
    },
    header(id: string, entries: readonly any[]) {
      const scope = active(id, entries);
      return {
        id,
        toolbarSlot: evaluate(toolbar.condition.getText(app), scope) ? evaluate(slotExpression, scope) : null,
        chatHeader: [false, true].flatMap(hasSession => [false, true].map(hasTitle => ({
          hasSession, hasTitle,
          visible: Boolean(evaluate(chat.condition.getText(app), { ...scope, currentChatHeaderSessionId: hasSession ? 's' : '', currentChatHeaderTitle: hasTitle ? 'title' : '' })),
        }))),
      };
    },
    environment(input: { dev: boolean; uiLabEnabled: boolean; isSmallScreen: boolean; workbenchActive: boolean; demo: boolean }, entries: readonly any[], contentNames: string[]) {
      const scope: Record<string, unknown> = {
        ...base, ...input, envDev: input.dev, currentView: 'chat-v2', visitedViews: new Set(), viewNavDirection: 1,
        ViewLayerRenderer: 'view-layer', RegisteredViewLayer: 'view-layer',
        resolveShellViewComponent: () => 'view-layer', viewLoadingFallback: null,
        retryHandlers: new Map(),
        Suspense: 'suspense', LazyWorkbenchDesktop: 'workbench', PageLoadingFallback: 'loading',
        viewEntries: entries, viewContents: {},
        ...Object.fromEntries(contentNames.map(name => [name, null])),
      };
      if (old) scope.renderViewLayer = get('renderViewLayer', scope);
      else {
        // W38: 视图层组装搬进 useViewLayer 的 return 表达式；执行它本身，注入数据而不复制算法。
        const viewLayerReturn = findNode(app, (node): node is ts.ReturnStatement =>
          ts.isReturnStatement(node) && Boolean(node.expression?.getText(app).includes('RegisteredViewLayer')));
        scope.registeredViewLayers = evaluate(viewLayerReturn.expression!.getText(app), scope);
      }
      const tree = evaluate(workspace.getText(app), scope);
      const views: string[] = [];
      function walk(node: React.ReactNode) {
        React.Children.forEach(node, child => {
          if (!React.isValidElement<{ view?: string; children?: React.ReactNode }>(child)) return;
          if (child.type === 'view-layer') views.push(child.props.view!);
          walk(child.props.children);
        });
      }
      walk(tree);
      return { ...input, views, desktopSidebar: Boolean(evaluate(sidebar.condition.getText(app), scope)) };
    },
    navigation(dev: boolean, demo: boolean, entries: readonly any[], inputs: string[]) {
      const canonicalScope: Record<string, unknown> = { envDev: dev };
      for (const name of ['DEPRECATED_VIEW_MAP', 'BASE_CANONICAL_VIEWS', 'DEV_ONLY_VIEWS', 'CANONICAL_VIEWS', 'canonicalizeView']) {
        canonicalScope[name] = evaluate(declaration(canonical, name).getText(canonical), canonicalScope);
      }
      let registeredResolver: (view: string, entries: readonly any[]) => string;
      if (!old) {
        const routing = readSource('src/ui-plugins/official/shell/navigation.ts');
        const resolver = findNode(routing, (node): node is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(node) && node.name?.text === 'resolveShellView');
        registeredResolver = evaluate(resolver.getText(routing).replace(/^export\s+/, ''), {
          canonicalizeView: canonicalScope.canonicalizeView, officialShellViewIds: officialViewIds,
        });
      }
      return { dev, demo, transitions: inputs.map(input => {
        let target: string | null = null;
        let committed: string | null = null;
        const events: unknown[] = [];
        const callback = get('setCurrentView', {
          ...base, isDemoShell: demo, currentViewRef: { current: 'chat-v2' }, viewEntriesRef: { current: entries },
          canonicalizeView: (value: string) => (target = (canonicalScope.canonicalizeView as (view: string) => string)(value)),
          resolveShellView: (value: string, currentEntries: readonly any[]) => (target = registeredResolver(value, currentEntries)),
          pageLifecycleTracker: { isEnabled: () => false, log: () => undefined },
          dispatchAppEvent: (_name: unknown, detail: unknown) => events.push(detail), APP_EVENTS: { VIEW_SWITCHED: 'view-switched' },
          startTransition: (fn: () => void) => fn(), advanceViewNavStack: () => undefined,
          viewNavStackRef: { current: ['chat-v2'] }, setViewNavDirection: () => undefined,
          setVisitedViews: () => undefined, setCurrentViewRaw: (value: string) => { committed = value; },
        });
        callback(input);
        return { input, target, committed, events };
      }) };
    },
  };
}
