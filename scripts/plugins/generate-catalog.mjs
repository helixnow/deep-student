#!/usr/bin/env node
/**
 * 插件能力目录生成器。
 *
 * 按 host/profiles/desktop.json 发现全部桌面模块（内核 / 外壳 / 平台 / 业务插件），
 * 读取各入口的 definePlugin meta、各模块 api.ts / portable.ts / *-api.ts / types/*.ts 的
 * `declare module` 服务声明、AST 扫描 inject / ctx.get / provide 依赖，以及
 * contracts/ipc/*.json 的命令与事件，生成 docs/plugins/CAPABILITIES.md。
 *
 *   node scripts/plugins/generate-catalog.mjs            # 重新生成
 *   node scripts/plugins/generate-catalog.mjs --check    # 本地漂移检测
 *
 * 目录只做静态分析：不执行插件模块源码，避免各 lane 的构造参数属性等
 * 非擦除语法影响生成器，也避免加载原生依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KERNEL = path.join(ROOT, 'host/kernel');
const PLUGINS = path.join(ROOT, 'host/plugins');
const PLATFORM = path.join(ROOT, 'host/platform');
const ELECTRON = path.join(ROOT, 'electron');
const DESKTOP_PROFILE = path.join(ROOT, 'host/profiles/desktop.json');
const CONTRACTS = path.join(ROOT, 'contracts/ipc');
const OUT = path.join(ROOT, 'docs/plugins/CAPABILITIES.md');

const KERNEL_SERVICES = [
  ['app', 'AppInfo（host/kernel/core.ts）：应用信息（dataDir、version、platform、debug）'],
  ['commands', 'CommandRegistry（host/kernel/commands.ts）：IPC 命令注册与调用'],
  ['backendEvents', 'BackendEventService（host/kernel/events.ts）：Host 与渲染进程事件收发'],
  ['uiEvents', 'UiEventService（host/kernel/events.ts）：受限的插件命名空间 UI 事件通道'],
  ['protocols', 'ProtocolService（host/kernel/protocols.ts）：自定义协议注册'],
  ['shell', 'ShellService（host/kernel/shell.ts）：请求 Electron main 执行外壳操作'],
  ['dstuPluginInstaller', 'DstuPluginInstaller（host/kernel/plugin-admin.ts）：内置插件专用的插件安装与工坊自检能力'],
  ['pluginAgentTools', 'PluginAgentToolsService（host/kernel/plugin-agent-tools.ts）：社区插件声明的智能体工具表'],
  ['pluginCaller', 'PluginCallerService（host/kernel/plugin-caller.ts）：查询当前调用方插件归属'],
  ['declarativeAssets', 'DeclarativeAssetRegistry（host/kernel/declarative-registry.ts）：Plugin v2 Tier 1 声明式资产注册表'],
];

const KIND_LABELS = {
  kernel: '内核',
  shell: '外壳',
  platform: '平台',
  plugin: '业务',
};

const isTestFile = (file) =>
  /\.test\.ts$/.test(file) || /\.spec\.ts$/.test(file) || /(^|\/)(tests|__tests__|__fixtures__)\//.test(file);

const isMobileOnlyFile = (file) => {
  const base = path.basename(file);
  if (base === 'mobile.ts' || base === 'mobile-search.ts' || base === 'mobile-local-runtime.ts' || base === 'mobile-security-status.ts') {
    return true;
  }
  const normalized = file.replaceAll('\\', '/');
  return /\/src\/mobile\//.test(normalized) || /\/src\/register-mobile-/.test(normalized);
};

const isDeclarationFile = (file) => {
  if (isTestFile(file) || isMobileOnlyFile(file)) return false;
  const base = path.basename(file);
  if (base === 'api.ts' || base === 'portable.ts' || base.endsWith('-api.ts')) return true;
  return path.basename(path.dirname(file)) === 'types' && base.endsWith('.ts');
};

const isPublishedPluginApi = (targetRel) =>
  targetRel.endsWith('/api.ts')
  || targetRel.endsWith('/api/index.ts')
  || targetRel.endsWith('/api.d.ts')
  || targetRel.endsWith('/portable.ts');

const rel = (file) => path.relative(ROOT, file).replaceAll('\\', '/');

// ---------------------------------------------------------------- TS 解析

const sourceCache = new Map();

function readSource(file) {
  let sf = sourceCache.get(file);
  if (sf === undefined) {
    sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    sourceCache.set(file, sf);
  }
  return sf;
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** 查找本文件中导入该局部标识符的相对模块与源导出名。 */
function findImportedBinding(sf, localName) {
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    if (clause.name && clause.name.text === localName) {
      return { specifier, exportName: 'default' };
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly) continue;
        if (element.name.text === localName) {
          return { specifier, exportName: element.propertyName ? element.propertyName.text : element.name.text };
        }
      }
    }
  }
  return null;
}

function findTopLevelVariable(sf, name) {
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration.initializer ?? null;
      }
    }
  }
  return null;
}

/** 在目标模块中查找导出变量（支持直接声明、export { x } from 与 export * from 转发）。 */
function findExportedVariable(sf, exportName, seenFiles = new Set()) {
  if (seenFiles.has(sf.fileName)) return null;
  seenFiles.add(sf.fileName);
  if (exportName === 'default') {
    for (const statement of sf.statements) {
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        return { node: statement.expression, sf };
      }
    }
  } else {
    const local = findTopLevelVariable(sf, exportName);
    if (local !== null) return { node: local, sf };
  }
  for (const statement of sf.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.isTypeOnly) continue;
    const targetFile = resolveImport(sf.fileName, statement.moduleSpecifier.text);
    if (targetFile === null) continue;
    if (!statement.exportClause) {
      const found = findExportedVariable(readSource(targetFile), exportName, seenFiles);
      if (found !== null) return found;
    } else if (ts.isNamedExports(statement.exportClause)) {
      for (const el of statement.exportClause.elements) {
        if (el.isTypeOnly) continue;
        if (el.name.text === exportName) {
          const sourceName = el.propertyName ? el.propertyName.text : el.name.text;
          const found = findExportedVariable(readSource(targetFile), sourceName, seenFiles);
          if (found !== null) return found;
        }
      }
    }
  }
  return null;
}

function findVariableInBlock(block, name) {
  if (!block || !ts.isBlock(block)) return null;
  for (const statement of block.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration.initializer ?? null;
      }
    }
  }
  return null;
}

/** 求值对象/数组字面量；支持顶层/工厂局部 const、跨文件相对导入常量、展开元素、属性访问、三元条件、as const、括号。 */
function evalLiteral(node, sf, visited = new Set(), env = null) {
  if (!node) return undefined;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return evalLiteral(node.expression, sf, visited, env);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;
  if (ts.isArrayLiteralExpression(node)) {
    const out = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        const spread = evalLiteral(element.expression, sf, visited, env);
        if (Array.isArray(spread)) out.push(...spread);
      } else {
        out.push(evalLiteral(element, sf, visited, env));
      }
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const object = {};
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = evalLiteral(property.expression, sf, visited, env);
        if (spread && typeof spread === 'object') Object.assign(object, spread);
        continue;
      }
      if (!ts.isPropertyAssignment(property)) continue;
      const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : property.name.getText(sf);
      object[key] = evalLiteral(property.initializer, sf, visited, env);
    }
    return object;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const target = evalLiteral(node.expression, sf, visited, env);
    if (target && typeof target === 'object') return target[node.name.text];
    return undefined;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'includes') {
    const target = evalLiteral(node.expression.expression, sf, visited, env);
    const arg = evalLiteral(node.arguments[0], sf, visited, env);
    if (Array.isArray(target)) return target.includes(arg);
    if (target === undefined || target === null) return false;
    return undefined;
  }
  if (ts.isBinaryExpression(node)) {
    const left = evalLiteral(node.left, sf, visited, env);
    const right = evalLiteral(node.right, sf, visited, env);
    if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return left === right;
    if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return left !== right;
    return undefined;
  }
  if (ts.isConditionalExpression(node)) {
    const condition = evalLiteral(node.condition, sf, visited, env);
    return evalLiteral(condition ? node.whenTrue : node.whenFalse, sf, visited, env);
  }
  if (ts.isIdentifier(node)) {
    if (node.text === 'undefined') return undefined;
    if (env && env.bindings && Object.prototype.hasOwnProperty.call(env.bindings, node.text)) {
      return env.bindings[node.text];
    }
    const visitKey = `${sf.fileName}#${node.text}`;
    if (visited.has(visitKey)) return undefined;
    visited.add(visitKey);
    if (env && env.body) {
      const localInFn = findVariableInBlock(env.body, node.text);
      if (localInFn !== null) return evalLiteral(localInFn, sf, visited, env);
    }
    const local = findTopLevelVariable(sf, node.text);
    if (local !== null) return evalLiteral(local, sf, visited, null);
    const imported = findImportedBinding(sf, node.text);
    if (imported !== null) {
      const targetFile = resolveImport(sf.fileName, imported.specifier);
      if (targetFile !== null) {
        const exported = findExportedVariable(readSource(targetFile), imported.exportName);
        if (exported !== null) return evalLiteral(exported.node, exported.sf, visited, null);
      }
    }
  }
  return undefined;
}

function findEnclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function findDefinePlugin(sf) {
  let found = null;
  const visit = (node) => {
    if (found === null && ts.isCallExpression(node) && node.expression.getText(sf) === 'definePlugin') {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function unwrapExpression(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current))) {
    current = current.expression;
  }
  return current;
}

/** 跟踪直接 definePlugin、default 重导出与工厂函数包装（export default createXxxPlugin(...)）。 */
function findPluginDefinition(file, visited = new Set(), callArgs = []) {
  if (visited.has(file)) return null;
  visited.add(file);
  const sf = readSource(file);
  const direct = findDefinePlugin(sf);
  if (direct !== null) {
    let env = null;
    const fn = findEnclosingFunction(direct);
    if (fn && callArgs.length > 0) {
      const bindings = {};
      fn.parameters.forEach((param, index) => {
        if (ts.isIdentifier(param.name)) bindings[param.name.text] = callArgs[index];
      });
      env = { bindings, body: fn.body };
    }
    return { call: direct, sf, file, env };
  }

  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.exportClause;
      const forwardsDefault = clause && ts.isNamedExports(clause)
        && clause.elements.some((el) => el.name.text === 'default');
      if (forwardsDefault) {
        const target = resolveImport(file, statement.moduleSpecifier.text);
        if (target !== null) {
          const found = findPluginDefinition(target, visited, callArgs);
          if (found !== null) return found;
        }
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      let expr = unwrapExpression(statement.expression);
      if (ts.isIdentifier(expr)) {
        const localInit = findTopLevelVariable(sf, expr.text);
        if (localInit !== null) {
          expr = unwrapExpression(localInit);
        } else {
          const imported = findImportedBinding(sf, expr.text);
          if (imported !== null) {
            const target = resolveImport(file, imported.specifier);
            if (target !== null) {
              const found = findPluginDefinition(target, visited, callArgs);
              if (found !== null) return found;
            }
          }
        }
      }
      if (expr && ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
        const imported = findImportedBinding(sf, expr.expression.text);
        if (imported !== null) {
          const target = resolveImport(file, imported.specifier);
          if (target !== null) {
            const evaluatedArgs = expr.arguments.map((arg) => evalLiteral(arg, sf));
            const found = findPluginDefinition(target, visited, evaluatedArgs);
            if (found !== null) return found;
          }
        }
      }
    }
  }
  return null;
}

function classifyKind(file) {
  if (file.startsWith(KERNEL + path.sep)) return 'kernel';
  if (file.startsWith(ELECTRON + path.sep)) return 'shell';
  if (file.startsWith(PLATFORM + path.sep)) return 'platform';
  return 'plugin';
}

/** 读取模块入口的 definePlugin 字面量；支持 default 转发与工厂函数模块（createXxxPlugin）。 */
function parsePluginEntry(file, optional = false) {
  const found = findPluginDefinition(file);
  if (found === null) {
    if (optional) return null;
    throw new Error(`${rel(file)}: no definePlugin(...) call`);
  }
  const literal = evalLiteral(found.call.arguments[0], found.sf, new Set(), found.env);
  if (literal === undefined || typeof literal !== 'object') throw new Error(`${rel(file)}: definePlugin argument is not a static object`);
  const meta = literal.meta ?? {};
  const platforms = Array.isArray(meta.platforms) ? meta.platforms.filter((name) => typeof name === 'string') : [];
  // 跳过仅限移动端的独立替代入口（如 storage-mobile、mobile-compat），避免与桌面同名 id / 命令冲突。
  if (platforms.length > 0 && !platforms.includes('desktop')) return null;
  const inject = Array.isArray(literal.inject)
    ? literal.inject.filter((name) => typeof name === 'string')
    : literal.inject && typeof literal.inject === 'object'
      ? Object.entries(literal.inject).filter(([, required]) => Boolean(required)).map(([name]) => name)
      : [];
  return {
    id: String(meta.id ?? ''),
    lane: typeof meta.lane === 'string' ? meta.lane : null,
    commands: Array.isArray(meta.commands) ? meta.commands.filter((name) => typeof name === 'string') : [],
    provides: Array.isArray(meta.provides) ? meta.provides.filter((name) => typeof name === 'string') : [],
    inject,
    file,
    dir: path.dirname(file),
    kind: classifyKind(file),
    singleFile: path.basename(file) !== 'index.ts',
  };
}

function isCtxExpr(node) {
  if (ts.isIdentifier(node) && node.text === 'ctx') return true;
  if (ts.isPropertyAccessExpression(node)
    && node.expression.kind === ts.SyntaxKind.ThisKeyword
    && node.name.text === 'ctx') {
    return true;
  }
  return false;
}

function stringArg(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** 通过 TS AST 扫描 ctx.get / ctx.provide / ctx.reflect.provide / super(ctx, ...)，避免 JSDoc 注释误报。 */
function scanRuntimeCalls(file) {
  const sf = readSource(file);
  const gets = [];
  const provides = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const target = callee.expression;
        if (method === 'get' && isCtxExpr(target)) {
          const name = stringArg(node.arguments[0]);
          if (name && !/^<.*>$/.test(name) && !/\s/.test(name)) gets.push(name);
        } else if (method === 'provide') {
          const isDirectProvide = isCtxExpr(target);
          const isReflectProvide = ts.isPropertyAccessExpression(target)
            && target.name.text === 'reflect'
            && isCtxExpr(target.expression);
          if (isDirectProvide || isReflectProvide) {
            const name = stringArg(node.arguments[0]);
            if (name) provides.push(name);
          }
        }
      } else if (callee.kind === ts.SyntaxKind.SuperKeyword && node.arguments.length >= 2) {
        const first = node.arguments[0];
        const name = stringArg(node.arguments[1]);
        if (ts.isIdentifier(first) && first.text === 'ctx' && name) {
          provides.push(name);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { gets, provides };
}

/** 通过 TS AST 扫描静态 import/export from 与动态 import() 的相对模块路径。 */
function scanImports(file) {
  const sf = readSource(file);
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specifiers;
}

/** api.ts 中 `declare module '@deepseek-ai/cordis' { interface Context { ... } }` 的服务声明。 */
function parseServiceDeclarations(file) {
  const sf = readSource(file);
  const out = [];
  const visit = (node) => {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name) && node.name.text === '@deepseek-ai/cordis') {
      const body = node.body;
      if (body && ts.isModuleBlock(body)) {
        for (const statement of body.statements) {
          if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== 'Context') continue;
          for (const member of statement.members) {
            if (!ts.isPropertySignature(member)) continue;
            // 迁移期的 `@deprecated` 类型别名不是运行时服务（例如 notes@1），不列入能力目录。
            if (ts.getJSDocTags(member).some((tag) => tag.tagName.text === 'deprecated')) continue;
            const name = ts.isStringLiteral(member.name) || ts.isIdentifier(member.name) ? member.name.text : member.name.getText(sf);
            out.push({
              name,
              type: member.type ? member.type.getText(sf) : 'unknown',
              optional: member.questionToken !== undefined,
              file,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 源码中的 PascalCase/dotted 服务名切片（供 mermaid 节点 ID 使用）。 */
const nodeId = (prefix, name) => `${prefix}_${name.replace(/[^A-Za-z0-9_]/g, '_')}`;

// ---------------------------------------------------------------- 扫描

function listDirs(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function walkTs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, out);
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const desktopProfile = JSON.parse(fs.readFileSync(DESKTOP_PROFILE, 'utf8'));
const entries = (desktopProfile.plugins ?? []).map((item) => {
  const file = path.resolve(path.dirname(DESKTOP_PROFILE), item.module);
  if (!fs.existsSync(file)) throw new Error(`${rel(DESKTOP_PROFILE)}: missing module ${item.module}`);
  const entry = parsePluginEntry(file);
  if (entry === null) throw new Error(`${rel(file)}: desktop profile entry is not enabled on desktop`);
  if (!entry.id) throw new Error(`${rel(entry.file)}: meta.id is missing or not a string literal`);
  if (item.id && entry.id !== item.id) {
    throw new Error(`${rel(entry.file)}: meta.id "${entry.id}" does not match desktop profile id "${item.id}"`);
  }
  return entry;
});

const pluginEntries = entries.filter((entry) => entry.kind === 'plugin');
const platformEntries = entries.filter((entry) => entry.kind === 'platform');
const kernelEntries = entries.filter((entry) => entry.kind === 'kernel');
const shellEntries = entries.filter((entry) => entry.kind === 'shell');

const entryById = new Map(entries.map((entry) => [entry.id, entry]));
const entryFiles = new Set(entries.map((entry) => entry.file));

function entrySourceFiles(entry) {
  if (entry.singleFile) return [entry.file];
  return walkTs(entry.dir).filter((file) => {
    if (isTestFile(file) || isMobileOnlyFile(file)) return false;
    if (file !== entry.file && entryFiles.has(file)) return false;
    return true;
  });
}

// 服务声明（插件 + 平台 + 内核 + 外壳，覆盖 api.ts / portable.ts / *-api.ts / types/*.ts）。
const declarations = [];
const MOBILE_ONLY_DIRS = new Set(['storage-mobile', 'mobile-compat']);
const declarationFiles = new Set();
for (const dir of [
  ...listDirs(PLUGINS).filter((name) => !MOBILE_ONLY_DIRS.has(name)).map((name) => path.join(PLUGINS, name)),
  ...listDirs(PLATFORM).filter((name) => !MOBILE_ONLY_DIRS.has(name)).map((name) => path.join(PLATFORM, name)),
]) {
  if (!fs.existsSync(dir)) continue;
  for (const file of walkTs(dir)) {
    if (isDeclarationFile(file)) declarationFiles.add(file);
  }
}
for (const file of walkTs(KERNEL)) {
  if (!isTestFile(file) && !isMobileOnlyFile(file)) declarationFiles.add(file);
}
const electronApi = path.join(ELECTRON, 'api.ts');
if (fs.existsSync(electronApi)) declarationFiles.add(electronApi);
for (const file of [...declarationFiles].sort()) {
  declarations.push(...parseServiceDeclarations(file));
}

// inject / ctx.get 消费方；以及运行时 provide 调用（用于发现 meta 漂移）。
const requiredConsumers = new Map();
const optionalConsumers = new Map();
const runtimeProvides = new Map();
const addTo = (map, name, value) => {
  const list = map.get(name) ?? [];
  if (!list.includes(value)) list.push(value);
  map.set(name, list);
};
for (const entry of entries) {
  for (const name of entry.inject) addTo(requiredConsumers, name, entry.id);
  for (const file of entrySourceFiles(entry)) {
    const { gets, provides } = scanRuntimeCalls(file);
    for (const name of gets) addTo(optionalConsumers, name, entry.id);
    for (const name of provides) addTo(runtimeProvides, name, entry.id);
  }
}

// 契约命令与事件。
const contracts = fs.readdirSync(CONTRACTS)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(fs.readFileSync(path.join(CONTRACTS, name), 'utf8')));
const contractCommands = new Map();
const contractEvents = [];
for (const contract of contracts) {
  const lane = typeof contract.lane === 'string' ? contract.lane : null;
  for (const command of contract.commands ?? []) {
    if (typeof command.name === 'string') contractCommands.set(command.name, lane);
  }
  for (const event of contract.events ?? []) {
    if (typeof event.name === 'string') {
      contractEvents.push({
        name: event.name,
        lane,
        dynamic: event.dynamic === true,
        payload: event.payload?.$ref ? String(event.payload.$ref).split('/').pop() : null,
      });
    }
  }
}

// 跨插件 import：是否绕过 api.ts / portable.ts。
const importIssues = [];
for (const entry of entries) {
  for (const file of entrySourceFiles(entry)) {
    for (const specifier of scanImports(file)) {
      const target = resolveImport(file, specifier);
      if (target === null) continue;
      const targetRel = rel(target);
      const pluginMatch = /^host\/plugins\/([^/]+)\//.exec(targetRel);
      if (pluginMatch === null || pluginMatch[1] === path.basename(entry.dir)) continue;
      if (isPublishedPluginApi(targetRel)) continue;
      importIssues.push({ from: rel(file), to: targetRel, plugin: entry.id, targetPlugin: pluginMatch[1] });
    }
  }
}

// ---------------------------------------------------------------- 服务模型

const serviceNames = new Set([
  ...declarations.map((declaration) => declaration.name),
  ...entries.flatMap((entry) => entry.provides),
  ...requiredConsumers.keys(),
  ...optionalConsumers.keys(),
  ...runtimeProvides.keys(),
  ...KERNEL_SERVICES.map(([name]) => name),
]);

const providersOf = new Map();
for (const entry of entries) {
  for (const name of entry.provides) addTo(providersOf, name, entry.id);
}

const lanePlugins = new Map();
for (const entry of entries) {
  if (entry.lane === null) continue;
  const list = lanePlugins.get(entry.lane) ?? [];
  list.push(entry.id);
  lanePlugins.set(entry.lane, list);
}

const services = [...serviceNames].map((name) => {
  const declared = declarations.filter((declaration) => declaration.name === name);
  const providers = providersOf.get(name) ?? [];
  const runtime = runtimeProvides.get(name) ?? [];
  const required = requiredConsumers.get(name) ?? [];
  const optional = (optionalConsumers.get(name) ?? []).filter((id) => !required.includes(id));
  const kernel = KERNEL_SERVICES.some(([kernelName]) => kernelName === name);
  const providerLanes = [...new Set(providers.map((id) => entryById.get(id)?.lane).filter(Boolean))];
  const events = contractEvents.filter((event) => event.lane !== null && providerLanes.includes(event.lane));
  const commands = providers.flatMap((id) => entryById.get(id)?.commands ?? []);
  return {
    name,
    kernel,
    declared,
    providers,
    runtime,
    required,
    optional,
    events,
    commands,
    status: kernel ? 'kernel'
      : providers.length > 1 ? 'duplicate'
        : providers.length === 1 ? (declared.length > 0 ? 'ok' : 'undeclared')
          : declared.length > 0 ? 'missing' : 'unresolved',
  };
});
services.sort((a, b) => a.name.localeCompare(b.name));

// 消费方引用了既没有声明也没有提供的名字（拼写/版本后缀不匹配）。
const unresolvedConsumers = services.filter(
  (service) => service.status === 'unresolved' && (service.required.length > 0 || service.optional.length > 0),
);

// 服务命名约定（保留 main 旧生成器的检查）：ctx 上的服务名 lowerCamelCase，不带版本号、点号或 @。
const NAME_OK = /^[a-z][A-Za-z0-9]*$/;
const namingIssues = services.filter((service) => !service.kernel && !NAME_OK.test(service.name));

// 已提供但没有任何插件在运行时消费（排除提供方自身），保留 main 旧生成器的接线自检。
const unusedProviders = services.filter((service) => {
  if (service.kernel || service.providers.length === 0) return false;
  return ![...service.required, ...service.optional].some((id) => !service.providers.includes(id));
});

// 提供方 meta 与运行时 provide 不一致。
const provideMismatches = [];
for (const entry of entries) {
  for (const name of entry.provides) {
    const runtime = runtimeProvides.get(name) ?? [];
    if (!runtime.includes(entry.id)) provideMismatches.push({ id: entry.id, name, kind: 'meta-only' });
  }
}
for (const [name, providers] of runtimeProvides) {
  for (const id of providers) {
    const declared = entryById.get(id)?.provides ?? [];
    if (!declared.includes(name)) provideMismatches.push({ id, name, kind: 'runtime-only' });
  }
}

// 服务声明是否落在提供方插件自己的 api.ts 里（websearch 这类“声明在 A、提供在 B”的 seam 需要评审）。
const declarationElsewhere = services.filter((service) => {
  if (service.kernel || service.providers.length === 0 || service.declared.length === 0) return false;
  const providerDirs = service.providers.map((id) => entryById.get(id)?.dir).filter(Boolean);
  return !service.declared.some((declaration) =>
    providerDirs.some((dir) => declaration.file === path.join(dir, 'api.ts') || declaration.file.startsWith(dir + path.sep)));
});

// 命令：声明了但契约里没有 / 被多个插件声明 / 契约里定义但桌面未注册。
const registeredCommands = new Set();
const unknownCommands = [];
for (const entry of entries) {
  for (const command of entry.commands) {
    registeredCommands.add(command);
    if (!contractCommands.has(command)) unknownCommands.push({ id: entry.id, command });
  }
}
const duplicateCommands = [];
{
  const owners = new Map();
  for (const entry of entries) for (const command of entry.commands) addTo(owners, command, entry.id);
  for (const [command, ids] of owners) if (ids.length > 1) duplicateCommands.push({ command, ids });
}
const unregisteredContractCommands = [...contractCommands.entries()]
  .filter(([command]) => !registeredCommands.has(command))
  .map(([command, lane]) => ({ command, lane }))
  .sort((a, b) => a.command.localeCompare(b.command));

// ---------------------------------------------------------------- 渲染

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function table(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.map(escapeCell).join(' | ')} |`);
  return lines;
}

function renderMermaid() {
  const lines = ['```mermaid', 'graph LR'];
  lines.push('  classDef plugin fill:#eef4ff,stroke:#4263a8,color:#1a2b4a;');
  lines.push('  classDef service fill:#fff8e6,stroke:#b7791f,color:#4a3200;');
  lines.push('  classDef missing fill:#fff5f5,stroke:#c53030,stroke-dasharray:4 2,color:#742a2a;');
  const edges = new Set();
  const serviceNodes = services.filter((service) => !service.kernel);
  for (const entry of entries) {
    lines.push(`  ${nodeId('p', entry.id)}["${entry.id}"]:::plugin`);
  }
  for (const service of serviceNodes) {
    const id = nodeId('s', service.name);
    lines.push(`  ${id}(["${service.name}"]):::${service.status === 'missing' || service.status === 'unresolved' ? 'missing' : 'service'}`);
    for (const provider of service.providers) {
      const edge = `  ${nodeId('p', provider)} -->|provides| ${id}`;
      if (!edges.has(edge)) {
        lines.push(edge);
        edges.add(edge);
      }
    }
    for (const consumer of service.required) {
      const edge = `  ${id} -->|inject| ${nodeId('p', consumer)}`;
      if (!edges.has(edge)) {
        lines.push(edge);
        edges.add(edge);
      }
    }
    for (const consumer of service.optional) {
      const edge = `  ${id} -.->|get| ${nodeId('p', consumer)}`;
      if (!edges.has(edge)) {
        lines.push(edge);
        edges.add(edge);
      }
    }
  }
  lines.push('```');
  return lines;
}

function render() {
  const pluginCount = pluginEntries.length;
  const platformCount = platformEntries.length;
  const kernelCount = kernelEntries.length;
  const shellCount = shellEntries.length;
  const commandCount = entries.reduce((sum, entry) => sum + entry.commands.length, 0);
  const serviceCount = services.filter((service) => !service.kernel).length;
  const missing = services.filter((service) => service.status === 'missing');
  const undeclared = services.filter((service) => service.status === 'undeclared');
  const duplicates = services.filter((service) => service.status === 'duplicate');

  const lines = [];
  lines.push('# 插件能力清单（Capability Seams）');
  lines.push('');
  lines.push('> 自动生成，请勿手改：`node scripts/plugins/generate-catalog.mjs`。本地可用 `--check` 检测漂移。');
  lines.push('> 与 DeepSeek Harness 的 `docs/capability-seams.md` 对齐：服务是插件之间唯一的跨 lane 编程接口，');
  lines.push('> 命令与事件是面向 UI/main 的线缆。插件编写指南见 `docs/plugins/SDK.md`。');
  lines.push('');
  lines.push(`统计：共 ${entries.length} 个桌面模块（${pluginCount} 个业务插件、${platformCount} 个平台插件、${kernelCount} 个内核插件、${shellCount} 个外壳插件）、${serviceCount} 个服务 seam、`
    + `${commandCount} / ${contractCommands.size} 条契约命令（已注册 / 总计）、${contractEvents.length} 个契约事件。`);
  lines.push('');

  lines.push('## 1. 服务 seam');
  lines.push('');
  lines.push('`inject` 是启动前必须就绪的强依赖；`ctx.get` 是运行时可选发现。`ctx` 上的服务名使用');
  lines.push('lowerCamelCase，不带版本号、点号或 `@`；版本由 `api.ts` 导出的服务描述对象声明，');
  lines.push('破坏性变更使用新名字并保留旧服务一个周期（见 `ARCHITECTURE.md` §3）。');
  lines.push('');
  const serviceRows = services.map((service) => {
    const provider = service.kernel ? 'kernel（根 context）'
      : service.providers.length > 0 ? service.providers.join('<br>') : '**缺失**';
    const declaredAt = service.declared.length > 0
      ? [...new Set(service.declared.map((declaration) => rel(declaration.file)))].join('<br>')
      : '—';
    const required = service.required.length > 0 ? service.required.join('<br>') : '—';
    const optional = service.optional.length > 0 ? service.optional.join('<br>') : '—';
    return [
      `\`${service.name}\``,
      service.kernel ? 'kernel' : '插件',
      provider,
      required,
      optional,
      declaredAt,
      String(service.commands.length),
      String(service.events.length),
    ];
  });
  lines.push(...table(['服务', '归属', '提供方', '消费方（inject）', '消费方（ctx.get）', '声明位置', '提供方命令数', 'lane 事件数'], serviceRows));
  lines.push('');
  lines.push('说明：平台插件（`host/platform/*`）与 kernel 服务也列入表中；kernel 服务挂在根 context，插件无需 inject。');
  lines.push('服务版本见提供方 `api.ts` 导出的描述对象（如 `export const ankiService = { name: \'anki\', version: \'1.0.0\' }`）。');
  lines.push('“提供方命令数”与“lane 事件数”按提供方插件/lane 汇总，用于判断 seam 的规模，不是服务方法级计数。');
  lines.push('具体命令见 §3.1 提供方插件的分组，事件见 §4（按 lane 展开）。');
  lines.push('');

  lines.push('## 2. 关系图');
  lines.push('');
  lines.push('实线 = `meta.provides` / `inject`；虚线 = `ctx.get` 可选发现；红色虚线节点 = 声明了但没有提供方。');
  lines.push('');
  lines.push(...renderMermaid());
  lines.push('');

  lines.push('## 3. 插件目录');
  lines.push('');
  const pluginRows = entries.map((entry) => [
    `\`${entry.id}\``,
    entry.lane ?? '—',
    KIND_LABELS[entry.kind] ?? entry.kind,
    entry.provides.length > 0 ? entry.provides.map((name) => `\`${name}\``).join('<br>') : '—',
    entry.inject.length > 0 ? entry.inject.map((name) => `\`${name}\``).join('<br>') : '—',
    String(entry.commands.length),
    rel(entry.file),
  ]);
  lines.push(...table(['插件 id', 'lane', '类型', 'provides', 'inject', '命令数', '入口'], pluginRows));
  lines.push('');

  lines.push('### 3.1 命令');
  lines.push('');
  lines.push('命令名必须存在于 `contracts/ipc/*.json`；同一命令只能由一个插件注册。按插件分组：');
  lines.push('');
  for (const entry of entries) {
    if (entry.commands.length === 0) continue;
    lines.push(`<details><summary><code>${entry.id}</code>（${entry.commands.length}）</summary>`);
    lines.push('');
    for (const command of entry.commands) lines.push(`- \`${command}\``);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  lines.push('## 4. 事件');
  lines.push('');
  lines.push(`契约事件 ${contractEvents.length} 个（来自 contracts/ipc）。lane 对应插件见第 3 节。`);
  lines.push('');
  const eventRows = [...contractEvents]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((event) => [
      `\`${event.name}\``,
      event.lane ?? '—',
      event.dynamic ? '动态名' : '静态',
      event.payload === null ? '—' : `\`${event.payload}\``,
      (event.lane !== null ? lanePlugins.get(event.lane) ?? [] : []).join('<br>') || '—',
    ]);
  lines.push(...table(['事件', 'lane', '名称', '载荷', '插件'], eventRows));
  lines.push('');

  lines.push('## 5. 服务边界检查');
  lines.push('');
  lines.push('本节由生成器静态检查，报告的是**需要提供方/消费方确认**的 seam 问题；不代替运行时 profile 校验。');
  lines.push('');

  lines.push(`### 5.1 声明了但未 provide（${missing.length}）`);
  lines.push('');
  lines.push('“可选声明”指 `api.ts` 中类型带 `?` 的服务（例如由 F2/main 在运行时注入的端口）。');
  lines.push('');
  if (missing.length === 0) lines.push('无。');
  else {
    lines.push(...table(['服务', '可选声明', '声明位置', '消费方'], missing.map((service) => [
      `\`${service.name}\``,
      service.declared.some((declaration) => declaration.optional) ? '是' : '否',
      [...new Set(service.declared.map((declaration) => rel(declaration.file)))].join('<br>'),
      [...service.required, ...service.optional].join('<br>') || '—',
    ])));
  }
  lines.push('');

  lines.push(`### 5.2 提供了但未在 api.ts 声明（${undeclared.length}）`);
  lines.push('');
  if (undeclared.length === 0) lines.push('无。');
  else {
    lines.push(...table(['服务', '提供方', '运行时 provide 位置'], undeclared.map((service) => [
      `\`${service.name}\``,
      service.providers.join('<br>'),
      service.runtime.join('<br>') || '—',
    ])));
  }
  lines.push('');

  lines.push(`### 5.3 多个提供方（${duplicates.length}）`);
  lines.push('');
  if (duplicates.length === 0) lines.push('无。');
  else lines.push(...table(['服务', '提供方'], duplicates.map((service) => [`\`${service.name}\``, service.providers.join('<br>')])));
  lines.push('');

  lines.push(`### 5.4 消费了但既未声明也未提供（${unresolvedConsumers.length}）`);
  lines.push('');
  if (unresolvedConsumers.length === 0) lines.push('无。');
  else {
    lines.push(...table(['服务名', '消费方'], unresolvedConsumers.map((service) => [
      `\`${service.name}\``,
      [
        ...service.required.map((id) => `inject：${id}`),
        ...service.optional.map((id) => `ctx.get：${id}`),
      ].join('<br>') || '—',
    ])));
  }
  lines.push('');

  lines.push(`### 5.5 meta.provides 与运行时 provide 不一致（${provideMismatches.length}）`);
  lines.push('');
  if (provideMismatches.length === 0) lines.push('无。');
  else {
    lines.push(...table(['插件', '服务', '问题'], provideMismatches.map((item) => [
      `\`${item.id}\``,
      `\`${item.name}\``,
      item.kind === 'meta-only' ? 'meta 声明了，源码中未找到 provide 调用（可能是动态注册）' : '运行时 provide 了，但 meta.provides 未声明（安装会失败）',
    ])));
  }
  lines.push('');

  lines.push(`### 5.6 绕过 api.ts / portable.ts 的跨插件 import（${importIssues.length}）`);
  lines.push('');
  if (importIssues.length === 0) lines.push('无。');
  else {
    const grouped = new Map();
    for (const issue of importIssues) {
      const key = `${issue.plugin} -> ${issue.targetPlugin}`;
      const list = grouped.get(key) ?? [];
      list.push(`${issue.from} → ${issue.to}`);
      grouped.set(key, list);
    }
    const rows = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, list]) => [
      key.replace(' -> ', ' → '),
      String(list.length),
      list.slice(0, 5).join('<br>') + (list.length > 5 ? `<br>… 其余 ${list.length - 5} 处` : ''),
    ]);
    lines.push(...table(['插件对', '数量', '示例'], rows));
  }
  lines.push('');

  lines.push(`### 5.7 命令声明与契约（未知 ${unknownCommands.length}，重复 ${duplicateCommands.length}，契约未注册 ${unregisteredContractCommands.length}）`);
  lines.push('');
  if (unknownCommands.length === 0 && duplicateCommands.length === 0 && unregisteredContractCommands.length === 0) {
    lines.push('无。');
    lines.push('');
  } else {
    if (unknownCommands.length > 0) {
      lines.push('契约中不存在：');
      lines.push('');
      lines.push(...table(['插件', '命令'], unknownCommands.map((item) => [`\`${item.id}\``, `\`${item.command}\``])));
      lines.push('');
    }
    if (duplicateCommands.length > 0) {
      lines.push('被多个插件声明：');
      lines.push('');
      lines.push(...table(['命令', '插件'], duplicateCommands.map((item) => [`\`${item.command}\``, item.ids.join('<br>')])));
      lines.push('');
    }
    if (unregisteredContractCommands.length > 0) {
      lines.push(`契约中已定义但桌面 profile 未注册（已注册 ${commandCount} / 总计 ${contractCommands.size}）：`);
      lines.push('');
      lines.push(...table(['命令', 'lane'], unregisteredContractCommands.map((item) => [`\`${item.command}\``, item.lane ?? '—'])));
      lines.push('');
    }
  }

  lines.push(`### 5.8 服务声明不在提供方 api.ts（${declarationElsewhere.length}）`);
  lines.push('');
  lines.push('消费方通常会按“声明位置”去 import 类型；声明与提供分离会让 seam 的归属不清晰，需要提供方确认。');
  lines.push('');
  if (declarationElsewhere.length === 0) lines.push('无。');
  else {
    lines.push(...table(['服务', '提供方', '声明位置'], declarationElsewhere.map((service) => [
      `\`${service.name}\``,
      service.providers.join('<br>'),
      [...new Set(service.declared.map((declaration) => rel(declaration.file)))].join('<br>'),
    ])));
  }
  lines.push('');

  lines.push(`### 5.9 服务名不符合约定（${namingIssues.length}）`);
  lines.push('');
  lines.push('`ctx` 上的服务名应为 lowerCamelCase，不含版本号、点号或 `@`；版本通过 `api.ts` 描述对象声明，');
  lines.push('破坏性变更使用新名字（如 `ankiV2`），旧服务保留一个周期，见 `ARCHITECTURE.md` §3。');
  lines.push('');
  if (namingIssues.length === 0) lines.push('无。');
  else {
    lines.push(...table(['服务', '提供方'], namingIssues.map((service) => [
      `\`${service.name}\``,
      service.providers.join('<br>') || '—',
    ])));
  }
  lines.push('');

  lines.push(`### 5.10 已提供但无运行时消费方（${unusedProviders.length}）`);
  lines.push('');
  lines.push('提供方已注册服务，但除提供方自身外没有 `inject` / `ctx.get` 使用；可能是生产路径未接线，需确认。');
  lines.push('');
  if (unusedProviders.length === 0) lines.push('无。');
  else {
    lines.push(...table(['服务', '提供方'], unusedProviders.map((service) => [
      `\`${service.name}\``,
      service.providers.join('<br>'),
    ])));
  }
  lines.push('');

  lines.push('## 6. 维护方式');
  lines.push('');
  lines.push('- 新增/删除服务、命令、事件后运行 `node scripts/plugins/generate-catalog.mjs`，把结果与源码一起提交。');
  lines.push('- 本地运行 `node scripts/plugins/generate-catalog.mjs --check` 检测漂移；文档与源码不一致时退出码 1。');
  lines.push('- 服务接口由提供方的 `api.ts` 声明并导出；消费方只从提供方 `api.ts` 导入类型。');
  lines.push('');
  return lines.join('\n');
}

const content = render();
const args = process.argv.slice(2);
for (const arg of args) {
  if (arg !== '--check' && arg !== '--help') {
    console.error(`plugin-catalog: unknown argument ${arg}`);
    process.exit(2);
  }
}
if (args.includes('--help')) {
  console.log('usage: node scripts/plugins/generate-catalog.mjs [--check]');
  process.exit(0);
}

if (args.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (current === content) {
    console.log('plugin-catalog: OK');
    process.exit(0);
  }
  if (current === null) {
    console.error(`plugin-catalog: ${rel(OUT)} is missing; run node scripts/plugins/generate-catalog.mjs`);
  } else {
    const expected = content.split('\n');
    const actual = current.split('\n');
    let line = 0;
    while (line < expected.length && line < actual.length && expected[line] === actual[line]) line += 1;
    console.error(`plugin-catalog: ${rel(OUT)} is stale at line ${line + 1}; run node scripts/plugins/generate-catalog.mjs`);
    console.error(`  expected: ${JSON.stringify(expected[line] ?? '<EOF>')}`);
    console.error(`  actual:   ${JSON.stringify(actual[line] ?? '<EOF>')}`);
  }
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, content);
console.log(`plugin-catalog: wrote ${rel(OUT)} (${content.split('\n').length} lines)`);
