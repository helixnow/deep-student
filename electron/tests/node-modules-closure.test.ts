/**
 * 打包时的生产依赖闭包（`electron/scripts/node-modules-closure.cjs`）：按 Node 解析规则从 package.json
 * 走出全部运行时依赖，补齐 electron-builder 收集漏掉的包（软链的 node_modules 让 `npm ls` 把依赖标为
 * missing；平台可选包如 `@koromix/koffi-darwin-arm64` 也会被漏掉）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { builderFilter } from './builder-filter.ts';

interface Target { platform: string; arch: string }
const require = createRequire(import.meta.url);
const { collectProductionClosure, productionFileSets, packageFilter } = require('../scripts/node-modules-closure.cjs') as {
  collectProductionClosure(projectDir: string, target: Target, extraRoots?: readonly string[]): Map<string, string>;
  productionFileSets(projectDir: string, target: Target, extraRoots?: readonly string[]): Array<{ from: string; to: string; filter: string[] }>;
  packageFilter(name: string, target: Target): string[];
};
const builderConfig = require('../electron-builder.config.cjs') as { files: string[] };

function pkg(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'index.js'), `module.exports = ${JSON.stringify(manifest.name)};\n`);
}

/** 项目目录的 node_modules 是指向共享安装的软链（与工作树相同的布局）。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ds-closure-'));
  const shared = join(root, 'shared', 'node_modules');
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: 'app', dependencies: { cordis: '^4', native: '^1', tar: '^7' }, devDependencies: { vite: '^6' },
  }));
  pkg(join(shared, 'cordis'), { name: 'cordis', dependencies: { cosmokit: '~1' }, peerDependencies: { schema: '*', absent: '*' }, peerDependenciesMeta: { absent: { optional: true } } });
  pkg(join(shared, 'cosmokit'), { name: 'cosmokit' });
  pkg(join(shared, 'schema'), { name: 'schema' });
  pkg(join(shared, 'native'), { name: 'native', optionalDependencies: { 'native-darwin-arm64': '1', 'native-linux-x64': '1', 'native-win32-x64': '1' } });
  pkg(join(shared, 'native-darwin-arm64'), { name: 'native-darwin-arm64', os: ['darwin'], cpu: ['arm64'] });
  pkg(join(shared, 'native-linux-x64'), { name: 'native-linux-x64', os: ['linux'], cpu: ['x64'] });
  // tar 嵌套了与根目录不同版本的 yallist。
  pkg(join(shared, 'tar'), { name: 'tar', dependencies: { yallist: '^5' } });
  pkg(join(shared, 'tar', 'node_modules', 'yallist'), { name: 'yallist', version: '5.0.0' });
  pkg(join(shared, 'yallist'), { name: 'yallist', version: '3.1.1' });
  pkg(join(shared, 'vite'), { name: 'vite' });
  symlinkSync(shared, join(project, 'node_modules'));
  return { root, project, shared };
}

describe('production node_modules closure', () => {
  it('follows dependencies, installed peers and platform-matching optional packages with Node resolution', () => {
    const { project, shared } = fixture();
    const closure = collectProductionClosure(project, { platform: 'darwin', arch: 'arm64' });
    expect([...closure.keys()].sort()).toEqual([
      'cordis', 'cosmokit', 'native', 'native-darwin-arm64', 'schema', 'tar', 'tar/node_modules/yallist',
    ]);
    expect(closure.get('tar/node_modules/yallist')).toBe(realpathSync(join(shared, 'tar', 'node_modules', 'yallist')));
    expect([...collectProductionClosure(project, { platform: 'linux', arch: 'x64' }).keys()]).toContain('native-linux-x64');
  });

  it('a missing required dependency is an error, not a silently broken package', () => {
    const { project, shared } = fixture();
    pkg(join(shared, 'cordis'), { name: 'cordis', dependencies: { cosmokit: '~1', gone: '1' } });
    expect(() => collectProductionClosure(project, { platform: 'darwin', arch: 'arm64' })).toThrow(/gone.*cordis/);
  });

  it('electron-builder file sets: one per package, nested versions get their own set at the same relative location', () => {
    const { project, shared } = fixture();
    const sets = productionFileSets(project, { platform: 'darwin', arch: 'arm64' });
    expect(sets.map((set) => set.to)).toEqual([
      'node_modules/cordis', 'node_modules/cosmokit', 'node_modules/native', 'node_modules/native-darwin-arm64',
      'node_modules/schema', 'node_modules/tar', 'node_modules/tar/node_modules/yallist',
    ]);
    const tar = sets.find((set) => set.to === 'node_modules/tar')!;
    expect(tar).toEqual({ from: realpathSync(join(shared, 'tar')), to: 'node_modules/tar', filter: packageFilter('tar', { platform: 'darwin', arch: 'arm64' }) });
    expect(tar.filter[0]).toBe('**/*');
    // electron-builder 丢弃相对 from 恰为 node_modules 的目录：tar 的 FileSet 带不走 yallist@5，必须单独一个。
    const yallist = sets.find((set) => set.to === 'node_modules/tar/node_modules/yallist')!;
    expect(yallist).toEqual({ from: realpathSync(join(shared, 'tar', 'node_modules', 'yallist')), to: 'node_modules/tar/node_modules/yallist', filter: packageFilter('yallist', { platform: 'darwin', arch: 'arm64' }) });
    expect(JSON.parse(readFileSync(join(yallist.from, 'package.json'), 'utf8')).version).toBe('5.0.0');
    expect(productionFileSets(project, { platform: 'linux', arch: 'x64' }).map((set) => set.to)).toContain('node_modules/native-linux-x64');
  });

  it('extra roots join the closure as required packages with their own dependencies', () => {
    const { project, shared } = fixture();
    pkg(join(shared, 'cookie'), { name: 'cookie', dependencies: { tldts: '^6' } });
    pkg(join(shared, 'tldts'), { name: 'tldts' });
    expect([...collectProductionClosure(project, { platform: 'darwin', arch: 'arm64' }, ['cookie']).keys()]).toEqual(
      expect.arrayContaining(['cookie', 'tldts']));
    expect(() => collectProductionClosure(project, { platform: 'darwin', arch: 'arm64' }, ['missing-root'])).toThrow(/missing-root/);
  });
});

const repoRoot = join(import.meta.dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', '__fixtures__', 'fixtures', 'equivalence', 'e2e', 'testing', '.build', 'scripts']);

const FUNCTION_SCOPES = new Set([
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
]);

function isCreateRequireCall(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (ts.isIdentifier(callee) && callee.text === 'createRequire') || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createRequire');
}

/**
 * 离 `use` 最近的 `require` 声明：`createRequire(…)` 的结果为 `'loader'`，其他声明（局部函数、参数、别的值）为
 * `'other'`；作用域链上都没有时为 `null`（CommonJS 的全局 require）。
 */
function requireBinding(use: ts.Identifier): 'loader' | 'other' | null {
  const named = (name: ts.Node | undefined) => name !== undefined && ts.isIdentifier(name) && name.text === 'require';
  for (let scope: ts.Node | undefined = use.parent; scope !== undefined; scope = scope.parent) {
    if (FUNCTION_SCOPES.has(scope.kind)) {
      const fn = scope as ts.SignatureDeclaration;
      if (fn.parameters.some((parameter) => named(parameter.name))) return 'other';
      if (ts.isFunctionExpression(scope) && named(scope.name)) return 'other';
    }
    if (ts.isCatchClause(scope) && named(scope.variableDeclaration?.name)) return 'other';
    if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope))
      && scope.initializer !== undefined && ts.isVariableDeclarationList(scope.initializer)
      && scope.initializer.declarations.some((declaration) => named(declaration.name))) return 'other';
    if (!ts.isSourceFile(scope) && !ts.isBlock(scope) && !ts.isModuleBlock(scope) && !ts.isCaseClause(scope) && !ts.isDefaultClause(scope)) continue;
    for (const statement of scope.statements) {
      if (ts.isFunctionDeclaration(statement) && named(statement.name)) return 'other';
      if (ts.isImportDeclaration(statement) && statement.importClause !== undefined) {
        const { name, namedBindings } = statement.importClause;
        if (named(name) || (namedBindings !== undefined && (ts.isNamespaceImport(namedBindings)
          ? named(namedBindings.name)
          : namedBindings.elements.some((element) => named(element.name))))) return 'other';
      }
      if (!ts.isVariableStatement(statement)) continue;
      const declaration = statement.declarationList.declarations.find((candidate) => named(candidate.name));
      if (declaration !== undefined) return declaration.initializer !== undefined && isCreateRequireCall(declaration.initializer) ? 'loader' : 'other';
    }
  }
  return null;
}

/** `require` 未声明（CommonJS 全局）或绑定到 `createRequire(…)`，以及直接调用 `createRequire(…)` 的结果。 */
function isModuleLoader(node: ts.Expression): boolean {
  if (isCreateRequireCall(node)) return true;
  return ts.isIdentifier(node) && node.text === 'require' && requireBinding(node) !== 'other';
}

/**
 * 一个源文件在运行时加载的模块说明符：静态 import / export … from（含 type-only）、副作用 import、`import()`、
 * `import x = require()`、模块加载器调用与其 `.resolve()`（见 {@link isModuleLoader}）。只认字符串字面量。
 */
function moduleSpecifiers(fileName: string, source: string): string[] {
  const kind = /\.[cm]?ts$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const specs: string[] = [];
  const add = (node: ts.Node | undefined) => { if (node !== undefined && ts.isStringLiteralLike(node)) specs.push(node.text); };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || isModuleLoader(callee)
        || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve' && isModuleLoader(callee.expression))) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specs;
}

// These assertions inspect the same immutable checkout. Keep only extracted strings, not ASTs,
// so the bare-import checks and relative-import check do not parse each shipped file three times.
const sourceImports = new Map<string, string[]>();
function sourceSpecifiers(file: string): string[] {
  let specs = sourceImports.get(file);
  if (specs === undefined) {
    specs = moduleSpecifiers(file, readFileSync(file, 'utf8'));
    sourceImports.set(file, specs);
  }
  return specs;
}

/** 随包运行的源码（electron-builder `files`：electron/** 与 host/**，去掉测试与构建脚本）中的裸包导入。 */
const ELECTRON_BUILTINS = new Set(['electron', 'original-fs']);

function shippedBareImports(): Map<string, string> {
  const builtins = new Set(builtinModules);
  const found = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(file);
        continue;
      }
      if (!/\.(ts|mts|cts|mjs|cjs|js)$/.test(entry.name) || /\.test\.|\.d\.ts$|\.config\.cjs$/.test(entry.name)) continue;
      for (const spec of sourceSpecifiers(file)) {
        if (spec === '' || /^(\.|\/|node:|#)/.test(spec)) continue;
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
        if (builtins.has(name) || ELECTRON_BUILTINS.has(name) || found.has(name)) continue;
        found.set(name, relative(repoRoot, file));
      }
    }
  };
  walk(join(repoRoot, 'electron'));
  walk(join(repoRoot, 'host'));
  return found;
}

describe('module specifier scan', () => {
  it('sees every import form and both module loaders: the CommonJS global and createRequire()', () => {
    expect(moduleSpecifiers('a.ts', [
      "import a from 'pkg-a';",
      "import type { B } from 'pkg-b/types';",
      "import 'pkg-side-effect';",
      "export { c } from '@scope/pkg-c/sub';",
      "const d = await import('pkg-d');",
      "import e = require('pkg-e');",
      "const require = createRequire(import.meta.url);",
      "require('pkg-f');",
      "require.resolve('pkg-g/file.wasm');",
      "createRequire(import.meta.url)('pkg-h');",
      "module.createRequire(import.meta.url).resolve('pkg-i/x.wasm');",
      "require(dynamicName);",
    ].join('\n'))).toEqual(['pkg-a', 'pkg-b/types', 'pkg-side-effect', '@scope/pkg-c/sub', 'pkg-d', 'pkg-e', 'pkg-f', 'pkg-g/file.wasm', 'pkg-h', 'pkg-i/x.wasm']);
    expect(moduleSpecifiers('b.cjs', "const x = require('pkg-cjs');\nmodule.exports = require.resolve('pkg-cjs-resolve');")).toEqual(['pkg-cjs', 'pkg-cjs-resolve']);
  });

  it('a local function, parameter or other value named require is not a module loader, only within its own scope', () => {
    expect(moduleSpecifiers('local.ts', [
      'export function bus(window: () => string | null) {',
      '  const require = (action: string) => { const target = window(); if (target === null) throw new Error(action); return target; };',
      "  return { emit() { return require('emitting'); }, listen() { return require('subscribing'); } };",
      '}',
      "function param(require: (s: string) => void) { require('param-arg'); }",
      "function declared() { function require(s: string) { return s; } return require('declared-arg'); }",
      "try { /* */ } catch (require) { require('caught-arg'); }",
      "require('outer-pkg');",
    ].join('\n'))).toEqual(['outer-pkg']);
    expect(moduleSpecifiers('nested.ts', [
      'const require = createRequire(import.meta.url);',
      "function inner() { const require = (s: string) => s; return require('shadowed-arg'); }",
      "function loads() { return require('outer-loader-pkg'); }",
    ].join('\n'))).toEqual(['outer-loader-pkg']);
    const executor = join(repoRoot, 'host', 'plugins', 'agent-skills', 'src', 'tools', 'workbench-chat-executor.ts');
    const specs = moduleSpecifiers(executor, readFileSync(executor, 'utf8'));
    expect(readFileSync(executor, 'utf8')).toContain("require('emitting')");
    expect(specs).not.toContain('emitting');
    expect(specs).not.toContain('subscribing');
  });
});

describe('packaged runtime imports', () => {
  it('every bare package imported by shipped code is declared in package.json dependencies and lands in the packaged closure', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const target = { platform: process.platform, arch: process.arch };
    const closure = collectProductionClosure(repoRoot, target);
    const imports = [...shippedBareImports()];
    // 只靠别的依赖传递、碰巧被提升才能解析的包，换掉上游依赖后会在打包产物里静默消失。
    expect(imports.filter(([name]) => !(name in manifest.dependencies)).map(([name, file]) => `${name} (${file})`)).toEqual([]);
    expect(imports.filter(([name]) => !closure.has(name)).map(([name, file]) => `${name} (${file})`)).toEqual([]);
  });

  it('the scan sees createRequire and require.resolve loads (argon2, pptxgenjs, tiktoken, pdfium wasm, backend Sentry)', () => {
    const imports = shippedBareImports();
    for (const name of ['@node-rs/argon2', 'pptxgenjs', 'tiktoken', '@embedpdf/pdfium', '@sentry/node']) expect(imports.has(name), name).toBe(true);
  });

  it('every relative import in a shipped source file resolves to a file the electron-builder files patterns also ship', () => {
    const ships = builderFilter(builderConfig.files);
    const posix = (file: string) => relative(repoRoot, file).split(sep).join('/');
    // ESM（含类型剥离的 .ts）只认写全的路径；CommonJS 的 require 另试扩展名与 index。
    const resolveRelative = (from: string, spec: string): string | null => {
      const base = resolve(dirname(from), spec);
      return [base, `${base}.js`, `${base}.json`, `${base}.cjs`, join(base, 'index.js')].find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile()) ?? null;
    };
    const shipped: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(file);
        } else if (/\.(ts|mts|cts|mjs|cjs|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts') && ships(posix(file))) {
          shipped.push(file);
        }
      }
    };
    walk(join(repoRoot, 'electron'));
    walk(join(repoRoot, 'host'));
    expect(shipped).toContain(join(repoRoot, 'host', 'kernel', 'manifest.ts'));
    const missing: string[] = [];
    for (const file of shipped) {
      for (const spec of sourceSpecifiers(file)) {
        if (!spec.startsWith('.')) continue;
        const target = resolveRelative(file, spec);
        if (target === null) missing.push(`${posix(file)} -> ${spec} (no such file)`);
        else if (!ships(posix(target))) missing.push(`${posix(file)} -> ${posix(target)} (not in files)`);
      }
    }
    expect(missing).toEqual([]);
  });
});
