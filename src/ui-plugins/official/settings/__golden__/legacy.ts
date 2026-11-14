/** Executable extraction of the pre-F1 extension point. No application code is changed. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

export const settingsPath = 'src/features/settings/components/Settings.tsx';
export const navigationPath = 'src/features/settings/components/useSettingsNavigation.tsx';

export function legacyNavigation(isMobile: boolean) {
  const source = fs.readFileSync(navigationPath, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, (...args: unknown[]) => unknown> = {};
  vm.runInNewContext(js, {
    exports,
    require: (name: string) => {
      if (name === 'react') return { useMemo: (fn: () => unknown) => fn() };
      if (name === 'react-i18next') return { useTranslation: () => ({ t: (key: string) => key }) };
      if (name === '@phosphor-icons/react') return new Proxy({}, { get: (_, key) => String(key) });
      if (name === '@/utils/platform') return { isMobilePlatform: () => isMobile };
      throw new Error(`Unexpected legacy import: ${name}`);
    },
  });
  return JSON.parse(JSON.stringify(exports.useSettingsNavigation!()));
}

export function sourceFile(file: string) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

export function lazyBoundaries(file: string) {
  const source = sourceFile(file);
  const result: { name: string; module: string; export: string }[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(source) === 'React.lazy') {
      const text = node.initializer.getText(source);
      const module = /import\('([^']+)'\)/.exec(text)![1]!;
      result.push({ name: node.name.getText(source), module: module.startsWith('.')
        ? path.posix.normalize(path.posix.join(path.posix.dirname(file), module)) : module.replace('@/', 'src/'),
      export: /default: module\.(\w+)/.exec(text)![1]! });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

export function legacyContent() {
  const source = sourceFile(settingsPath);
  const branches: { tab: string; condition: string; jsx: string }[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxExpression(node) && node.expression) {
      const text = node.expression.getText(source);
      const match = /^activeTab === '([^']+)'(?: && [^<]+)? && (\(?\s*<[^]*\)?)$/.exec(text);
      if (match && !text.includes('shrink-0 px-5')) {
        const jsx = match[2]!.replace(/^\(\s*/, '').replace(/\s*\)$/, '');
        branches.push({ tab: match[1]!, condition: text.slice(0, text.indexOf(jsx)).replace(/\s*&&\s*\(?\s*$/, ''), jsx });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return branches;
}

export function legacyEvidence() {
  const content = legacyContent();
  const tabs = [...new Set(content.map((branch) => branch.tab))];
  const cases = [];
  for (const isMobile of [false, true]) for (const isSmallScreen of [false, true])
    for (const demo of [false, true]) for (const theme of ['light', 'dark']) {
      cases.push({ input: { isMobile, isSmallScreen, demo, theme }, navigation: isMobile ? 'mobile' : 'desktop',
        content: tabs.map((tab) => ({ tab,
          branches: content.filter((branch) => branch.tab === tab && vm.runInNewContext(branch.condition,
            { activeTab: tab, isMobilePlatform: () => isMobile })).map((branch) => content.indexOf(branch)),
          redirect: tab === 'workbench' && isMobile ? 'apis' : null,
        })),
      });
    }
  return { tabs, lazy: lazyBoundaries(settingsPath), content,
    navigation: { desktop: legacyNavigation(false), mobile: legacyNavigation(true) }, cases };
}
