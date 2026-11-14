// Read-only extraction of the pre-slot shell. Kept for provenance; the golden
// comparison switches to the production registry after the evidence commit.
import ts from 'typescript';
import * as icons from '@/components/icons/StudySidebarIcons';
import { Database } from '@phosphor-icons/react';
import { consumerEvidence, LEGACY_REVISION, readSource } from './consumerEvidence';

const source = (path: string) => readSource(path, LEGACY_REVISION);
const app = source('src/App.tsx');
const mobile = source('src/components/layout/MobileSidebarNavigation.tsx');
const sidebar = source('src/components/ModernSidebar.tsx');
const chrome = source('src/app/hooks/useShellViewChrome.tsx');
const navigationSource = source('src/config/navigation.ts');
const canonicalSource = source('src/app/navigation/canonicalView.ts');
const cardsSource = source('src/app/navigation/cardsHub.ts');

function declarations(file: ts.SourceFile, name: string): ts.Expression {
  let value: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) value = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!value) throw new Error(`Missing legacy declaration ${name}`);
  return value;
}

function evaluate(text: string, scope: Record<string, unknown> = {}) {
  const js = ts.transpileModule(`const result = (${text});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return Function(...Object.keys(scope), `${js}; return result;`)(...Object.values(scope));
}
const label = (key: string, fallback?: string) => ({ key, fallback: fallback ?? null });
const iconNames = { ...icons, Database };
const iconName = (icon: unknown) => Object.entries(iconNames).find(([, value]) => value === icon)?.[0];

export function extractLegacyEvidence() {
  const createNavItems = evaluate(declarations(navigationSource, 'createNavItems').getText(navigationSource), iconNames);
  const cardsModule = ts.transpileModule(cardsSource.text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const { isCardsHubView } = Function('exports', `${cardsModule}; return exports;`)({});
  const views: { id: string; content: string; extraClass: string | null; gate: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(app) === 'renderViewLayer') {
      const [id, content, extraClass] = node.arguments;
      const parent = node.parent;
      views.push({
        id: evaluate(id.getText(app)), content: content.getText(app),
        extraClass: extraClass ? evaluate(extraClass.getText(app)) : null,
        gate: ts.isBinaryExpression(parent) ? parent.left.getText(app) : 'always',
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(app);
  const labels = evaluate(declarations(chrome, 'labels').getText(chrome), { t: (key: string) => key });
  const shortLabels = evaluate(declarations(mobile, 'LAUNCHER_SHORT_LABEL').getText(mobile));
  const fullLabels = evaluate(declarations(mobile, 'LAUNCHER_FULL_LABEL').getText(mobile));
  const mobileIcons = evaluate(declarations(mobile, 'LAUNCHER_ICONS').getText(mobile), Object.fromEntries(Object.keys(iconNames).map(key => [key, key])));
  const navigation = [false, true].map(uiLabEnabled => ({
    uiLabEnabled,
    items: createNavItems(label as never, uiLabEnabled).map(item => ({
      id: item.view, label: item.name, icon: iconName(item.icon),
    })),
  }));
  const mobileViews: string[] = evaluate(declarations(navigationSource, 'MOBILE_APP_LAUNCHER_VIEWS').getText(navigationSource));
  const mobileItems = mobileViews.map(id => ({ id, icon: mobileIcons[id], label: shortLabels[id], ariaLabel: fullLabels[id] }));
  const shell = views.map(({ id }) => {
    const scope = { currentView: id };
    const get = (name: string, extra = {}) => evaluate(declarations(app, name).getText(app), { ...scope, ...extra });
    const sidebarOwnsBackNavigation = get('isShellSidebarView');
    return {
      id, titleKey: labels[id], sidebarKind: get('desktopShellSidebarKind'),
      pageBackButton: get('shouldShowDesktopPageBackButton'),
      sidebarOwnsBackNavigation,
      sidebarToggle: [false, true].map(leftPanelCollapsed => get('shouldShowDesktopSidebarToggle', { leftPanelCollapsed })),
      headerNav: [false, true].map(leftPanelCollapsed => get('shouldShowDesktopHeaderNavControls', { leftPanelCollapsed, isShellSidebarView: sidebarOwnsBackNavigation })),
      mobileBackToHome: get('mobileHeaderCanGoBack', { unifiedCanGoBack: false }),
    };
  });
  // Extract JSX condition/slot expressions directly rather than restating the view lists.
  const jsx: Record<string, string> = {};
  const inspect = (node: ts.Node) => {
    if (ts.isConditionalExpression(node) && node.whenTrue.getText(app).startsWith('(') && node.whenTrue.getText(app).includes('<CardsHubTabs') && node.condition.getText(app).startsWith('isCardsHubView')) jsx.cardsHubTabs = node.condition.getText(app);
    if (ts.isBinaryExpression(node) && node.right.getText(app) === "'settings-view'") jsx.contentClass = node.getText(app);
    if (ts.isJsxAttribute(node) && node.name.getText(app) === 'data-shell-slot' && node.initializer && ts.isJsxExpression(node.initializer)) {
      const expression = node.initializer.expression!;
      if (ts.isConditionalExpression(expression)) jsx.toolbar = expression.getText(app);
    }
    if (ts.isConditionalExpression(node) && node.whenTrue.getText(app).includes('ref={setDesktopPageHeaderTarget}')) jsx.toolbarCondition = node.condition.getText(app);
    if (ts.isConditionalExpression(node) && node.whenTrue.getText(app).includes('<DesktopShellTitleEditor')) {
      if (node.condition.getText(app).includes('currentChatHeaderSessionId')) jsx.chatHeader = node.condition.getText(app);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(app);
  const consumers = consumerEvidence(LEGACY_REVISION);
  const header = views.map(({ id }) => ({
    ...consumers.header(id, []),
    cardsHubTabs: evaluate(jsx.cardsHubTabs, { currentView: id, isCardsHubView }),
    contentClass: evaluate(jsx.contentClass, { currentView: id }) || null,
  }));
  const primaryExpression = declarations(sidebar, 'primaryItems').getText(sidebar);
  const desktop = navigation.flatMap(({ uiLabEnabled, items }) => ['full', 'chat'].map(navigationScope => ({
    uiLabEnabled, navigationScope,
    ids: evaluate(primaryExpression, { useMemo: (fn: () => unknown) => fn(), navItems: items.map(item => ({ view: item.id })), navigationScope }).map((item: { view: string }) => item.view),
  })));
  const environments = [false, true].flatMap(dev => [false, true].flatMap(uiLabEnabled => [false, true].flatMap(isSmallScreen => [false, true].flatMap(workbenchActive => [false, true].map(demo =>
    consumers.environment({ dev, uiLabEnabled, isSmallScreen, workbenchActive, demo }, [], views.map(view => view.content))
  )))));
  const aliases = Object.keys(evaluate(declarations(canonicalSource, 'DEPRECATED_VIEW_MAP').getText(canonicalSource)));
  const inputs = [...new Set([...views.map(view => view.id), ...aliases, 'unknown-view'])];
  const navigationTransitions = [false, true].flatMap(dev => [false, true].map(demo => consumers.navigation(dev, demo, [], inputs)));
  return { views, navigation, mobileItems, desktop, shell, header, environments, navigationTransitions };
}
