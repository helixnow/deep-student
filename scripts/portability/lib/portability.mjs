// 可移植性扫描核心（W14）：统计业务插件对 Node 专有模块、原生模块、Node 专用包与 Node 全局量的依赖。
// 只做语法分析（TypeScript 编译器 API，不做类型检查）。CLI 见 ../scan.mjs，接入边界检查的说明见
// host/platform/API.md「可移植性扫描与边界接入」。
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';
import { isSourceFile, isTestFile } from '../../electron-migration/lib/boundary-rules.mjs';

const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));

/**
 * Node 内置模块的分类。tier：
 * - `service`：改走平台服务（ctx.files / ctx.crypto / ctx.http / ctx.paths …）；
 * - `desktop-only`：移动端没有等价物，插件应声明仅桌面或把这部分下沉到桌面平台服务；
 * - `web-standard`：有标准 Web API 或纯函数替代，改动小。
 * weight：每个文件迁移该依赖的估算工作量（单位约 15 分钟，含测试）。
 */
export const NODE_MODULES = {
  fs: { category: 'fs', tier: 'service', replacement: 'ctx.files（异步；同步调用的迁移方案见 SYNC-FS-PLAN.md）', weight: 3 },
  crypto: { category: 'crypto', tier: 'service', replacement: 'ctx.crypto；无 ctx 的同步小输入用 host/platform/crypto/sync.ts', weight: 1 },
  os: { category: 'os', tier: 'service', replacement: 'ctx.paths / ctx.app.platform', weight: 1 },
  http: { category: 'net', tier: 'service', replacement: 'ctx.http（服务端监听属仅桌面）', weight: 3 },
  https: { category: 'net', tier: 'service', replacement: 'ctx.http', weight: 3 },
  http2: { category: 'net', tier: 'service', replacement: 'ctx.http', weight: 3 },
  dns: { category: 'net', tier: 'service', replacement: 'ctx.http（destination / isPublicUrl）', weight: 2 },
  net: { category: 'net', tier: 'desktop-only', replacement: '仅桌面（套接字 / 本地服务）', weight: 4 },
  tls: { category: 'net', tier: 'desktop-only', replacement: '仅桌面', weight: 4 },
  dgram: { category: 'net', tier: 'desktop-only', replacement: '仅桌面', weight: 4 },
  zlib: { category: 'zlib', tier: 'service', replacement: 'CompressionStream / native compression 服务', weight: 2 },
  process: { category: 'process', tier: 'service', replacement: 'ctx.app / 插件配置', weight: 1 },
  child_process: { category: 'child_process', tier: 'desktop-only', replacement: '仅桌面（声明 platforms: [\'desktop\']）', weight: 5 },
  worker_threads: { category: 'threads', tier: 'desktop-only', replacement: '仅桌面，或改 Web Worker 平台服务', weight: 4 },
  cluster: { category: 'threads', tier: 'desktop-only', replacement: '仅桌面', weight: 4 },
  async_hooks: { category: 'runtime', tier: 'desktop-only', replacement: '显式传递上下文', weight: 2 },
  module: { category: 'runtime', tier: 'desktop-only', replacement: '静态 import', weight: 2 },
  vm: { category: 'runtime', tier: 'desktop-only', replacement: '仅桌面', weight: 3 },
  v8: { category: 'runtime', tier: 'desktop-only', replacement: '仅桌面', weight: 3 },
  inspector: { category: 'runtime', tier: 'desktop-only', replacement: '仅桌面', weight: 3 },
  repl: { category: 'runtime', tier: 'desktop-only', replacement: '仅桌面', weight: 3 },
  tty: { category: 'runtime', tier: 'desktop-only', replacement: '仅桌面', weight: 3 },
  wasi: { category: 'runtime', tier: 'desktop-only', replacement: 'WebAssembly 平台服务', weight: 3 },
  sqlite: { category: 'native', tier: 'desktop-only', replacement: 'ctx.storage', weight: 5 },
  path: { category: 'path', tier: 'web-standard', replacement: 'host/platform/util/path.ts（同名函数，语义同 node:path）；限定根目录用 files/path.ts', weight: 0.5 },
  url: { category: 'url', tier: 'web-standard', replacement: '全局 URL', weight: 0.25 },
  util: { category: 'util', tier: 'web-standard', replacement: 'TextDecoder / 手写 promisify', weight: 0.5 },
  events: { category: 'events', tier: 'web-standard', replacement: 'EventTarget / 轻量 emitter', weight: 0.5 },
  buffer: { category: 'buffer', tier: 'web-standard', replacement: 'Uint8Array + ctx.crypto 编码', weight: 1 },
  string_decoder: { category: 'buffer', tier: 'web-standard', replacement: 'TextDecoder({stream:true})', weight: 0.5 },
  stream: { category: 'stream', tier: 'web-standard', replacement: 'Web Streams', weight: 1.5 },
  timers: { category: 'timers', tier: 'web-standard', replacement: '全局 setTimeout / AbortSignal.timeout', weight: 0.25 },
  perf_hooks: { category: 'perf', tier: 'web-standard', replacement: '全局 performance', weight: 0.25 },
  assert: { category: 'assert', tier: 'web-standard', replacement: '显式检查', weight: 0.25 },
  readline: { category: 'stream', tier: 'web-standard', replacement: 'TextDecoderStream + 按行切分', weight: 1 },
  querystring: { category: 'url', tier: 'web-standard', replacement: 'URLSearchParams', weight: 0.25 },
};
const OTHER_BUILTIN = { category: 'other', tier: 'web-standard', replacement: '按需评估', weight: 0.5 };

/** 原生模块（移动端不可用）与 Node 专用的 npm 包。 */
const PACKAGES = [
  { test: /^(better-sqlite3|koffi|sharp|electron|keytar|node-pty|canvas|ffi-napi|fsevents|usb|serialport|bufferutil|utf-8-validate)(\/|$)/, rule: 'native', category: 'native', tier: 'desktop-only', replacement: '平台服务（ctx.storage / ctx.vector / native）或仅桌面', weight: 5 },
  { test: /^(@lancedb|@napi-rs|@node-rs|@electron)\//, rule: 'native', category: 'native', tier: 'desktop-only', replacement: '平台服务或仅桌面', weight: 5 },
  { test: /^(undici|node-fetch|@smithy\/node-http-handler|ws)(\/|$)/, rule: 'node-package', category: 'net', tier: 'service', replacement: 'ctx.http', weight: 2 },
  { test: /^(jsdom|chokidar)(\/|$)/, rule: 'node-package', category: 'runtime', tier: 'desktop-only', replacement: '仅桌面或平台服务', weight: 3 },
];

/** Node 全局量：值引用按运行时依赖计；只在类型位置出现按类型依赖计。 */
export const NODE_GLOBALS = {
  Buffer: { category: 'buffer', tier: 'web-standard', replacement: 'Uint8Array + ctx.crypto 编码', weight: 1 },
  process: { category: 'process', tier: 'service', replacement: 'ctx.app / 插件配置', weight: 0.5 },
  __dirname: { category: 'runtime', tier: 'service', replacement: 'import.meta.url', weight: 0.5 },
  __filename: { category: 'runtime', tier: 'service', replacement: 'import.meta.url', weight: 0.5 },
  require: { category: 'runtime', tier: 'desktop-only', replacement: '静态 import', weight: 1 },
  global: { category: 'runtime', tier: 'web-standard', replacement: 'globalThis', weight: 0.25 },
  setImmediate: { category: 'timers', tier: 'web-standard', replacement: 'queueMicrotask / setTimeout(0)', weight: 0.25 },
  clearImmediate: { category: 'timers', tier: 'web-standard', replacement: 'clearTimeout', weight: 0.25 },
  NodeJS: { category: 'types', tier: 'web-standard', replacement: '可移植类型（ReturnType<typeof setTimeout> 等）', weight: 0.25 },
};

/** 类型依赖（`import type`、类型位置的全局量）只占运行时依赖工作量的这个比例。 */
export const TYPE_ONLY_FACTOR = 0.25;
/** 每个同步调用（`*Sync(`）的额外工作量：改异步通常会沿调用链扩散。 */
export const SYNC_CALL_WEIGHT = 0.25;
/** 工作量单位折算：1 单位 ≈ 15 分钟，1 人日按 6 小时有效工时。 */
export const UNITS_PER_DAY = 24;

/**
 * 学习伴侣（移动端）范围内的插件，按 ASSAULT-PLAN §6「对话、笔记、刷题、Anki/FSRS 复习、与桌面同步」初拟，
 * 第二阶段由产品与插件 owner 确认。
 */
export const MOBILE_CORE = ['chat', 'chat-pipeline', 'llm', 'llm-providers', 'notes', 'vfs', 'vfs-repos', 'qbank', 'review', 'anki', 'memory', 'sync', 'sync-providers', 'sync-support'];

/** 内置模块说明符 → 顶层模块名（`node:fs/promises` → `fs`）；不是内置模块返回 null。 */
export function nodeBuiltinName(specifier) {
  const prefixed = specifier.startsWith('node:');
  const bare = prefixed ? specifier.slice(5) : specifier;
  const top = bare.split('/')[0];
  if (prefixed) return top;
  return BUILTINS.has(bare) || BUILTINS.has(top) ? top : null;
}

/** 说明符分类；不是 Node 专有依赖返回 null。 */
export function classifySpecifier(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  const builtin = nodeBuiltinName(specifier);
  if (builtin !== null) {
    const info = NODE_MODULES[builtin] ?? OTHER_BUILTIN;
    return { rule: 'node-builtin', module: builtin, ...info };
  }
  for (const entry of PACKAGES) {
    if (!entry.test.test(specifier)) continue;
    const scoped = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    const { test: _test, ...info } = entry;
    return { ...info, module: scoped };
  }
  return null;
}

export function findingKey(finding) {
  return `${finding.rule}${finding.typeOnly ? '-type' : ''}:${finding.module}`;
}

function declaredNames(sf) {
  const names = new Set();
  const visit = (node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) names.add(node.name.text);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) names.add(node.name.text);
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node)) {
      if (node.name) names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** 标识符是否是对同名全局量的引用（排除属性名、声明名、限定名右侧）。 */
function isGlobalReference(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)
    || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent)
    || ts.isEnumMember(parent)) && parent.name === node) return false;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent)
    || ts.isClassDeclaration(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)
    || ts.isNamespaceImport(parent) || ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent)
    || ts.isLabeledStatement(parent) || ts.isModuleDeclaration(parent)) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  return true;
}

function inTypePosition(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeReferenceNode(current) || ts.isTypeQueryNode(current) || ts.isImportTypeNode(current)) return true;
    if (ts.isExpressionWithTypeArguments(current) && current.parent && ts.isHeritageClause(current.parent)) {
      return current.parent.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(current.parent.parent);
    }
    if (ts.isQualifiedName(current)) continue;
    return false;
  }
  return false;
}

/**
 * 分析单个源文件。`rel` 为仓库相对路径（`/` 分隔）。返回：
 * - `findings`：Node 专有依赖（`typeOnly` 表示只在类型层面，Node 类型擦除后不会加载）；
 * - `runtimeSpecifiers`：运行时会加载的相对模块说明符（供传递分析）；
 * - `syncCalls`：`*Sync(` 调用次数。
 */
export function analyzeSource(rel, text) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, /x$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings = [];
  const runtimeSpecifiers = [];
  let syncCalls = 0;
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const record = (specifier, node, typeOnly, kind) => {
    if (!typeOnly && (specifier.startsWith('./') || specifier.startsWith('../'))) runtimeSpecifiers.push(specifier);
    const info = classifySpecifier(specifier);
    if (info !== null) findings.push({ ...info, specifier, line: lineOf(node), typeOnly, kind });
  };
  const locals = declaredNames(sf);
  const globalsSeen = new Map();

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier.text, node, Boolean(node.importClause?.isTypeOnly), 'import');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier.text, node, node.isTypeOnly, 'import');
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      record(node.moduleReference.expression.text, node, node.isTypeOnly, 'require');
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      record(node.argument.literal.text, node, true, 'import');
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require' && !locals.has('require');
      if ((isImport || isRequire) && arg && ts.isStringLiteralLike(arg)) record(arg.text, node, false, isImport ? 'dynamic' : 'require');
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (/^[a-z]\w*Sync$/.test(name)) syncCalls += 1;
    } else if (ts.isIdentifier(node) && Object.hasOwn(NODE_GLOBALS, node.text) && !locals.has(node.text) && isGlobalReference(node)) {
      if (!(node.text === 'require' && node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node)) {
        const typeOnly = node.text === 'NodeJS' || inTypePosition(node);
        const key = `${node.text}:${typeOnly}`;
        if (!globalsSeen.has(key)) {
          globalsSeen.set(key, true);
          findings.push({ rule: 'node-global', module: node.text, ...NODE_GLOBALS[node.text], specifier: node.text, line: lineOf(node), typeOnly, kind: 'global' });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // 同一全局量既有值引用又有类型引用时，只保留值引用（运行时依赖已涵盖）。
  const filtered = findings.filter((finding) => !(finding.kind === 'global' && finding.typeOnly && globalsSeen.has(`${finding.module}:false`)));
  return { findings: filtered, runtimeSpecifiers, syncCalls };
}

/** 单文件工作量：每个不同的依赖键计一次权重（类型依赖打折），再加同步调用。 */
export function fileEffort(analysis) {
  const seen = new Map();
  for (const finding of analysis.findings) {
    const key = findingKey(finding);
    if (!seen.has(key)) seen.set(key, finding.weight * (finding.typeOnly ? TYPE_ONLY_FACTOR : 1));
  }
  let units = [...seen.values()].reduce((sum, value) => sum + value, 0);
  if (analysis.findings.some((finding) => !finding.typeOnly)) units += analysis.syncCalls * SYNC_CALL_WEIGHT;
  return units;
}

// ------------------------------------------------------------------ 文件遍历与模块解析

function walk(dir, acc) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'dist' || entry.name === 'out') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile()) acc.push(full);
  }
  return acc;
}

export function toRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];

/** 相对说明符 → 仓库相对路径（不存在或不是源码返回 null）。`.js` 说明符也尝试同名 `.ts`。 */
export function resolveRelative(root, fromRel, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier.split('?')[0]));
  const candidates = RESOLVE_SUFFIXES.map((suffix) => base + suffix);
  if (/\.(m|c)?js$/.test(base)) candidates.push(base.replace(/\.(m|c)?js$/, (ext) => ext.replace('js', 'ts')));
  for (const candidate of candidates) {
    const abs = path.join(root, candidate);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return isSourceFile(candidate) ? candidate : null;
  }
  return null;
}

/** 带缓存的分析器：按需读取并分析任意仓库内源文件。 */
export function createAnalyzer(root) {
  const cache = new Map();
  const analyze = (rel) => {
    let entry = cache.get(rel);
    if (entry === undefined) {
      const analysis = analyzeSource(rel, fs.readFileSync(path.join(root, rel), 'utf8'));
      const runtimeDeps = [...new Set(analysis.runtimeSpecifiers.map((spec) => resolveRelative(root, rel, spec)).filter((dep) => dep !== null))];
      entry = { ...analysis, runtimeDeps };
      cache.set(rel, entry);
    }
    return entry;
  };
  /** 从若干入口出发的运行时可达文件集合（只沿非 `import type` 的相对导入）。 */
  const closure = (entries) => {
    const seen = new Set();
    const queue = [...entries];
    while (queue.length > 0) {
      const rel = queue.pop();
      if (seen.has(rel)) continue;
      seen.add(rel);
      for (const dep of analyze(rel).runtimeDeps) if (!seen.has(dep)) queue.push(dep);
    }
    return seen;
  };
  return { analyze, closure };
}

// ------------------------------------------------------------------ 插件元数据

/**
 * 从插件入口的源码里静态读出 `meta.platforms`（不执行模块）。支持数组字面量，或同文件内
 * `const X = [...]`（可带类型标注、`as const`）的标识符。未声明返回 null。
 */
export function declaredPlatforms(text) {
  const sf = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const constants = new Map();
  const strings = (array) => array.elements.filter(ts.isStringLiteralLike).map((element) => element.text);
  const unwrap = (expression) => (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) ? unwrap(expression.expression) : expression);
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = unwrap(node.initializer);
      if (ts.isArrayLiteralExpression(value)) constants.set(node.name.text, strings(value));
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  let found = null;
  const visit = (node) => {
    if (found !== null) return;
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'meta' && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== 'platforms') continue;
        const value = unwrap(property.initializer);
        if (ts.isArrayLiteralExpression(value)) found = strings(value);
        else if (ts.isIdentifier(value) && constants.has(value.text)) found = constants.get(value.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// ------------------------------------------------------------------ 扫描

/**
 * 扫描 `host/plugins/<插件>/`。返回 `{ summary, plugins, files }`：
 * `files` 是逐文件结果（含测试文件与否由 `includeTests` 决定），`plugins` 按工作量降序。
 */
export function scanPlugins(root, options = {}) {
  const includeTests = options.includeTests ?? false;
  const transitive = options.transitive ?? true;
  const only = options.plugins ? new Set(options.plugins) : null;
  const pluginsDir = path.join(root, 'host', 'plugins');
  const analyzer = createAnalyzer(root);
  const files = [];
  const plugins = [];
  const gatewayCache = new Map();
  const gatewayModules = (rel) => {
    let modules = gatewayCache.get(rel);
    if (modules === undefined) {
      modules = new Set();
      for (const file of analyzer.closure([rel])) {
        for (const finding of analyzer.analyze(file).findings) if (!finding.typeOnly) modules.add(findingKey(finding));
      }
      gatewayCache.set(rel, modules);
    }
    return modules;
  };

  const names = fs.existsSync(pluginsDir)
    ? fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    : [];
  for (const name of names) {
    if (only && !only.has(name)) continue;
    const pluginRoot = path.join(pluginsDir, name);
    const indexPath = path.join(pluginRoot, 'index.ts');
    const platforms = fs.existsSync(indexPath) ? declaredPlatforms(fs.readFileSync(indexPath, 'utf8')) : null;
    const pluginFiles = [];
    for (const abs of walk(pluginRoot, []).sort()) {
      const rel = toRel(root, abs);
      if (!isSourceFile(rel)) continue;
      const test = isTestFile(rel);
      if (test && !includeTests) continue;
      const analysis = analyzer.analyze(rel);
      const record = {
        file: rel,
        plugin: name,
        test,
        findings: analysis.findings.map(({ rule, module, category, tier, line, typeOnly, kind, specifier }) => ({ key: findingKey({ rule, module, typeOnly }), rule, module, category, tier, line, typeOnly, kind, specifier })),
        syncCalls: analysis.syncCalls,
        effort: fileEffort(analysis),
      };
      pluginFiles.push(record);
      files.push(record);
    }
    const runtimeImportFiles = pluginFiles.filter((file) => file.findings.some((finding) => !finding.typeOnly && finding.rule !== 'node-global'));
    const anyImportFiles = pluginFiles.filter((file) => file.findings.some((finding) => finding.rule !== 'node-global'));
    const runtimeAnyFiles = pluginFiles.filter((file) => file.findings.some((finding) => !finding.typeOnly));
    const modules = {};
    const tiers = {};
    for (const file of pluginFiles) {
      for (const key of new Set(file.findings.map((finding) => finding.key))) modules[key] = (modules[key] ?? 0) + 1;
      for (const tier of new Set(file.findings.filter((finding) => !finding.typeOnly).map((finding) => finding.tier))) tiers[tier] = (tiers[tier] ?? 0) + 1;
    }
    const units = pluginFiles.reduce((sum, file) => sum + file.effort, 0);
    const desktopOnlySignals = Object.keys(modules).filter((key) => !key.includes('-type:') && /^(node-builtin:(child_process|worker_threads|cluster|net|tls|dgram|vm|v8|inspector|module)|native:|node-package:(jsdom|chokidar))/.test(key));
    let gateways = [];
    if (transitive) {
      const own = new Set(pluginFiles.map((file) => file.file));
      const outside = new Set();
      for (const file of pluginFiles) {
        for (const dep of analyzer.analyze(file.file).runtimeDeps) if (!dep.startsWith(`host/plugins/${name}/`) && !own.has(dep)) outside.add(dep);
      }
      gateways = [...outside].sort()
        .map((file) => ({ file, modules: [...gatewayModules(file)].sort() }))
        .filter((gateway) => gateway.modules.length > 0);
    }
    plugins.push({
      name,
      declaredPlatforms: platforms,
      mobileCore: MOBILE_CORE.includes(name),
      files: pluginFiles.length,
      cleanFiles: pluginFiles.length - anyImportFiles.length,
      runtimePortableFiles: pluginFiles.length - runtimeAnyFiles.length,
      filesWithRuntimeImports: runtimeImportFiles.length,
      modules: Object.fromEntries(Object.entries(modules).sort(([a], [b]) => (a < b ? -1 : 1))),
      tiers,
      syncCalls: pluginFiles.reduce((sum, file) => sum + (file.findings.some((finding) => !finding.typeOnly) ? file.syncCalls : 0), 0),
      effort: { units: round(units), days: round(units / UNITS_PER_DAY) },
      suggestion: platforms?.length === 1 && platforms[0] === 'desktop'
        ? 'declared-desktop-only'
        : desktopOnlySignals.length > 0 ? 'split-or-desktop-only' : 'migrate',
      desktopOnlySignals,
      gateways,
    });
  }
  plugins.sort((a, b) => b.effort.units - a.effort.units || (a.name < b.name ? -1 : 1));
  markDesktopOnlyExemptions(analyzer, plugins, files);

  const summary = summarize(plugins, files);
  return { summary, plugins, files };
}

/**
 * 仅桌面豁免（`--check` 用），规则：
 * 1. 插件入口 `index.ts` 的 `meta.platforms` 恰好是 `['desktop']` 时，该插件的生产文件不报 NEW；
 *    未声明 `platforms` 的插件**不**豁免（缺省 desktop 只是历史状态，不是决定）。
 * 2. 但豁免插件里被“可移植根”在运行时可达的文件不豁免：它们是共享面，Node 依赖会经它们漏进移动端。
 *    可移植根 = 所有未豁免插件的生产文件 + 任何插件目录下的 `mobile.ts`（移动端变体）。
 * 结果写在每个文件记录的 `exempt`（布尔）与 `exemptBlockedBy`（第一个经由它可达的可移植根，未豁免时给出）。
 */
function markDesktopOnlyExemptions(analyzer, plugins, files) {
  const desktopOnly = new Set(plugins.filter((plugin) => plugin.suggestion === 'declared-desktop-only').map((plugin) => plugin.name));
  const roots = files
    .filter((file) => !file.test && (!desktopOnly.has(file.plugin) || file.file === `host/plugins/${file.plugin}/mobile.ts`))
    .map((file) => file.file);
  const reachedFrom = new Map();
  if (desktopOnly.size > 0) {
    const queue = roots.map((file) => [file, file]);
    for (const [file, start] of queue) reachedFrom.set(file, start);
    while (queue.length > 0) {
      const [file, start] = queue.shift();
      for (const dep of analyzer.analyze(file).runtimeDeps) {
        if (reachedFrom.has(dep)) continue;
        reachedFrom.set(dep, start);
        queue.push([dep, start]);
      }
    }
  }
  for (const file of files) {
    const shared = desktopOnly.has(file.plugin) ? reachedFrom.get(file.file) : undefined;
    file.exempt = desktopOnly.has(file.plugin) && shared === undefined;
    if (shared !== undefined && shared !== file.file) file.exemptBlockedBy = shared;
  }
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function summarize(plugins, files) {
  const byModule = {};
  for (const file of files) {
    for (const key of new Set(file.findings.map((finding) => finding.key))) byModule[key] = (byModule[key] ?? 0) + 1;
  }
  const total = files.length;
  const clean = plugins.reduce((sum, plugin) => sum + plugin.cleanFiles, 0);
  const runtimePortable = plugins.reduce((sum, plugin) => sum + plugin.runtimePortableFiles, 0);
  const units = plugins.reduce((sum, plugin) => sum + plugin.effort.units, 0);
  return {
    plugins: plugins.length,
    files: total,
    cleanFiles: clean,
    cleanPercent: total === 0 ? 100 : round((clean / total) * 100),
    runtimePortableFiles: runtimePortable,
    runtimePortablePercent: total === 0 ? 100 : round((runtimePortable / total) * 100),
    syncCalls: plugins.reduce((sum, plugin) => sum + plugin.syncCalls, 0),
    effort: { units: round(units), days: round(units / UNITS_PER_DAY) },
    byModule: Object.fromEntries(Object.entries(byModule).sort(([, a], [, b]) => b - a)),
  };
}

// ------------------------------------------------------------------ 基线

/**
 * 基线：每个生产文件出现过的依赖键（按出现与否，不按次数，避免行号/次数波动）。
 * 给了旧基线 `previous` 时，豁免文件（`compareWithBaseline` 不比较）只保留旧基线里已有且仍存在的键：
 * 它们的新依赖 `--check` 本来就不报，重写基线不能借机把它们加进去，否则“只减不增”时无法用 `--write-baseline`。
 */
export function buildBaseline(scan, previous) {
  const before = previous?.files;
  const files = {};
  for (const file of scan.files) {
    if (file.test || file.findings.length === 0) continue;
    let keys = [...new Set(file.findings.map((finding) => finding.key))];
    if (before && file.exempt) keys = keys.filter((key) => (before[file.file] ?? []).includes(key));
    if (keys.length > 0) files[file.file] = keys.sort();
  }
  return {
    $comment: 'Generated by node scripts/portability/scan.mjs --write-baseline; existing Node-specific dependencies of host/plugins (whitelist). Only shrink it.',
    version: 1,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

/**
 * 与基线比较：返回 `{ added, resolved }`。
 * - `added`：基线里没有的（文件, 依赖键），逐条带行号；仅桌面插件的文件按 `markDesktopOnlyExemptions` 的规则豁免
 *   （共享面除外，条目带 `sharedWith` 指出经由哪个可移植文件可达）；
 * - `resolved`：基线里有、现在已消失的条目（提示用 `--write-baseline` 收紧基线）。
 */
export function compareWithBaseline(scan, baseline) {
  const allowed = baseline?.files ?? {};
  const added = [];
  const current = new Map();
  for (const file of scan.files) {
    if (file.test) continue;
    const keys = new Set(file.findings.map((finding) => finding.key));
    current.set(file.file, keys);
    if (file.exempt) continue;
    const known = new Set(allowed[file.file] ?? []);
    for (const finding of file.findings) {
      if (known.has(finding.key)) continue;
      if (added.some((entry) => entry.file === file.file && entry.key === finding.key)) continue;
      added.push({ file: file.file, plugin: file.plugin, key: finding.key, line: finding.line, specifier: finding.specifier, replacement: replacementFor(finding), ...(file.exemptBlockedBy ? { sharedWith: file.exemptBlockedBy } : {}) });
    }
  }
  const resolved = [];
  for (const [file, keys] of Object.entries(allowed)) {
    const now = current.get(file);
    for (const key of keys) if (!now || !now.has(key)) resolved.push({ file, key });
  }
  return { added, resolved };
}

function replacementFor(finding) {
  if (finding.rule === 'node-global') return NODE_GLOBALS[finding.module]?.replacement ?? '';
  if (finding.rule === 'node-builtin') return (NODE_MODULES[finding.module] ?? OTHER_BUILTIN).replacement;
  return PACKAGES.find((entry) => entry.test.test(finding.specifier))?.replacement ?? '';
}

// ------------------------------------------------------------------ profile 可移植性

/**
 * 检查 profile（如 `host/profiles/mobile.json`）中每个模块的运行时闭包是否触达 Node 专有依赖。
 * 返回 `[{ id, module, violations: [{ file, key, line }] }]`。
 */
export function checkProfileClosure(root, profilePath) {
  const profileAbs = path.resolve(root, profilePath);
  const profile = JSON.parse(fs.readFileSync(profileAbs, 'utf8'));
  const analyzer = createAnalyzer(root);
  return profile.plugins.map((entry) => {
    const moduleRel = toRel(root, path.resolve(path.dirname(profileAbs), entry.module));
    return { id: entry.id, module: moduleRel, violations: closureViolations(analyzer, [moduleRel]) };
  });
}

/** 一组入口文件的运行时闭包中的 Node 专有依赖（不含 `import type` 与类型位置的全局量）。 */
export function checkModulesClosure(root, entries) {
  return closureViolations(createAnalyzer(root), entries);
}

function closureViolations(analyzer, entries) {
  const violations = [];
  for (const file of [...analyzer.closure(entries)].sort()) {
    for (const finding of analyzer.analyze(file).findings) {
      if (!finding.typeOnly) violations.push({ file, key: findingKey(finding), line: finding.line });
    }
  }
  return violations;
}

// ------------------------------------------------------------------ 移动端就绪度

/**
 * 每个业务插件入口（`host/plugins/<名>/index.ts`，有 `mobile.ts` 时用它）能否装进移动端 profile：
 * `ready` = 运行时闭包不含 Node 专有依赖。不就绪时给出阻塞来源：插件自身的文件（`own`），以及插件直接
 * 值导入的插件外模块里、闭包含 Node 依赖的那些（`gateways`，带闭包内违规文件数与前几个文件）。
 */
export function mobileReadiness(root, options = {}) {
  const analyzer = createAnalyzer(root);
  const pluginsDir = path.join(root, 'host', 'plugins');
  const bad = (file) => analyzer.analyze(file).findings.some((finding) => !finding.typeOnly);
  const out = [];
  for (const name of fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    if (options.plugins && !options.plugins.includes(name)) continue;
    const variant = `host/plugins/${name}/mobile.ts`;
    const entry = fs.existsSync(path.join(root, variant)) ? variant : `host/plugins/${name}/index.ts`;
    if (!fs.existsSync(path.join(root, entry))) continue;
    const prefix = `host/plugins/${name}/`;
    const closure = analyzer.closure([entry]);
    const own = [...closure].filter((file) => file.startsWith(prefix) && bad(file)).sort();
    const gateways = new Map();
    for (const file of closure) {
      if (!file.startsWith(prefix)) continue;
      for (const dep of analyzer.analyze(file).runtimeDeps) {
        if (dep.startsWith(prefix) || gateways.has(dep)) continue;
        const reaches = [...analyzer.closure([dep])].filter(bad).sort();
        if (reaches.length > 0) gateways.set(dep, reaches);
      }
    }
    out.push({
      name,
      entry,
      declaredPlatforms: declaredPlatforms(fs.readFileSync(path.join(root, entry), 'utf8')),
      ready: own.length === 0 && gateways.size === 0,
      own,
      gateways: [...gateways.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, reaches]) => ({ file, reaches })),
    });
  }
  return out;
}
