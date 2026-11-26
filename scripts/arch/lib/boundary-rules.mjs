// host/ 与 electron/ 的架构边界规则（README §5.2）。用 TypeScript 编译器 API 解析（不做类型检查），
// 只看语法：import / export from / 动态 import / require、字符串字面量、标识符、注释、catch 块。
import ts from 'typescript';
import path from 'node:path';

export const RULES = {
  'native-import': '只有 host/platform/<服务>/ 可以导入 electron 与原生驱动（better-sqlite3、@napi-rs/keyring、@lancedb/*）',
  'tauri-import': 'host/ 不得导入 @tauri-apps/*',
  'cross-plugin-impl': '插件之间只能经对方发布的 api.ts、portable.ts（或 contracts/）引用，不得引用对方的实现文件',
  'electron-imports-plugin': 'electron/ 不得导入 host/plugins/',
  'sql-outside-repository': 'SQL 只能写在插件的 repository/ 或存储平台 host/platform/storage/、host/platform/storage-mobile/ 中',
  'test-double': '生产代码不得出现 mock / fake / stub 标识符，也不得导入 vitest（测试替身只放 *.test.ts、*.spec.ts、__tests__/、__fixtures__/、tests/、host/e2e/**/support/、host/kernel/testing.ts）',
  'todo-marker': '生产代码不得出现 TODO / FIXME / unimplemented / not implemented',
  'empty-catch': '生产代码不得有空 catch 块（含 `.catch(() => {})`）',
  'erasable-syntax': '只能用可擦除的 TS 语法（Host 以 Node 类型擦除运行）：禁止构造函数参数属性、非 declare 的 enum、带实现的 namespace',
  'console-log': '生产代码不得用 console.*（日志走 ctx.log / Cordis logger；strict 模式）',
};

// 收紧中的规则：DSTU_BOUNDARY_STRICT=1 时启用（各 lane 清理完成后改为默认）。
const STRICT = process.env.DSTU_BOUNDARY_STRICT === '1';

const NATIVE = [/^electron(\/|$)/, /^better-sqlite3(\/|$)/, /^@napi-rs\/keyring(\/|$)/, /^@lancedb\//];
const TAURI = /^@tauri-apps\//;

const SOURCE_RE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

export function isSourceFile(rel) {
  return SOURCE_RE.test(rel) && !rel.endsWith('.d.ts') && !rel.endsWith('.d.mts');
}

/** 测试文件：`*.test.*`、Playwright `*.spec.ts`、`__tests__/`、`__fixtures__/`、插件 `tests/`、`host/e2e/**\/support/`、`host/kernel/testing.ts`。 */
export function isTestFile(rel) {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(rel) ||
    /\.spec\.ts$/.test(rel) ||
    /^host\/e2e\/(?:[^/]+\/)*support\//.test(rel) ||
    /(^|\/)(__tests__|__fixtures__)\//.test(rel) ||
    /^host\/plugins\/[^/]+\/tests\//.test(rel) ||
    rel === 'host/kernel/testing.ts'
  );
}

function pluginOf(rel) {
  return /^host\/plugins\/([^/]+)\//.exec(rel)?.[1] ?? null;
}

/**
 * 允许被其他插件引用的入口：`host/plugins/<p>/api.ts`（或 api/index.ts），以及 `portable.ts`——api.ts 中运行时闭包
 * 不含 Node 模块的子集（导出值与 api.ts 相同，由该插件的 tests/portability.test.ts 守护），供移动端也要加载的消费方使用。
 */
export function isPublishedApi(rel) {
  return /^host\/plugins\/[^/]+\/(api\.ts|api\/index\.ts|api\.d\.ts|portable\.ts)$/.test(rel);
}

function mayImportNative(rel) {
  return /^host\/platform\/[^/]+\//.test(rel);
}

function maySql(rel) {
  return /^host\/plugins\/[^/]+\/repository\//.test(rel) || /^host\/platform\/storage(?:-mobile)?\//.test(rel);
}

const SQL_RE = [
  /\bSELECT\b[\s\S]+?\bFROM\b/,
  /\bINSERT\s+(OR\s+\w+\s+)?INTO\b/i,
  /\bUPDATE\s+[`"[\w.\]]+\s+SET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bREPLACE\s+INTO\b/i,
  /\bCREATE\s+(TEMP(ORARY)?\s+)?(TABLE|(UNIQUE\s+)?INDEX|VIRTUAL\s+TABLE|TRIGGER|VIEW)\b/i,
  /\bALTER\s+TABLE\b/i,
  /\bDROP\s+(TABLE|INDEX|TRIGGER|VIEW)\b/i,
  /\bPRAGMA\s+\w+/i,
];

export function looksLikeSql(s) {
  return SQL_RE.some((re) => re.test(s));
}

const DOUBLE_WORDS = new Set(['mock', 'mocks', 'mocked', 'mocking', 'fake', 'fakes', 'faked', 'stub', 'stubs', 'stubbed']);

/** 标识符按 camelCase / snake_case / 数字拆段，任一段是 mock/fake/stub 系即命中。 */
export function isDoubleIdentifier(name) {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_$0-9]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
  return parts.some((p) => DOUBLE_WORDS.has(p));
}

// TODO/FIXME/XXX 只认大写（业务里有 user_todo、chat.tools.todo.* 等领域词）；unimplemented / not implemented 不分大小写。
const TODO_RE = /\b(TODO|FIXME|XXX)\b|\b[Uu]nimplemented\b|\b[Nn]ot\s+[Ii]mplemented\b/;

function resolveSpecifier(rel, spec) {
  if (spec.startsWith('.')) return path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
  if (spec.startsWith('/')) return null;
  return null;
}

/**
 * 检查单个文件。rel 为仓库相对路径（`/` 分隔）。返回 [{ rule, file, line, col, message }]。
 */
export function checkFile(rel, text) {
  const out = [];
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const test = isTestFile(rel);
  const inHost = rel.startsWith('host/');
  const inElectron = rel.startsWith('electron/');
  const plugin = pluginOf(rel);
  const at = (pos) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(pos);
    return { line: line + 1, col: character + 1 };
  };
  const report = (rule, pos, detail) => out.push({ rule, file: rel, ...at(pos), message: `${RULES[rule]}${detail ? `：${detail}` : ''}` });

  const checkSpecifier = (spec, pos) => {
    if (inHost && TAURI.test(spec)) report('tauri-import', pos, spec);
    if (NATIVE.some((re) => re.test(spec))) {
      if (inHost && !mayImportNative(rel)) report('native-import', pos, spec);
    }
    if (!test && spec === 'vitest' && (inHost || inElectron) && rel !== 'host/kernel/testing.ts') report('test-double', pos, 'import vitest');
    const target = resolveSpecifier(rel, spec);
    if (!target) return;
    if (inElectron && /^host\/plugins\//.test(target)) report('electron-imports-plugin', pos, spec);
    const targetPlugin = pluginOf(target.endsWith('/') ? target : `${target}`) ?? pluginOf(`${target}/`);
    if (plugin && targetPlugin && targetPlugin !== plugin) {
      const withExt = /\.[cm]?[jt]sx?$/.test(target) ? target : `${target}.ts`;
      // 测试可以导入对方插件入口 index.ts（默认导出即插件本身，是可安装的公开单元），用于把真实插件装进测试宿主。
      const isPluginEntry = test && /^host\/plugins\/[^/]+\/index\.ts$/.test(withExt);
      if (!isPluginEntry && !isPublishedApi(withExt) && !isPublishedApi(`${target}/index.ts`)) report('cross-plugin-impl', pos, spec);
    }
  };

  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      checkSpecifier(node.moduleSpecifier.text, node.moduleSpecifier.getStart(sf));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      checkSpecifier(node.moduleReference.expression.text, node.moduleReference.expression.getStart(sf));
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if ((isImport || isRequire) && arg && ts.isStringLiteralLike(arg)) checkSpecifier(arg.text, arg.getStart(sf));
      if (!test && ts.isPropertyAccessExpression(callee) && callee.name.text === 'catch' && arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) {
        const body = arg.body;
        if (ts.isBlock(body) && body.statements.length === 0) report('empty-catch', node.getStart(sf), '.catch(() => {})');
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      checkSpecifier(node.argument.literal.text, node.argument.literal.getStart(sf));
    }
    if (!test) {
      // strict：生产代码中的 console.*（host/platform/log 自身除外）。
      if (STRICT && !/^host\/platform\/log\//.test(rel) && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'console') report('console-log', node.getStart(sf), `console.${node.expression.name.text}`);
      // 不可擦除的 TS 语法：Node strip-only 无法运行（测试与 tsc 都发现不了，Host 启动时才崩）。
      if (ts.isParameter(node) && ts.isConstructorDeclaration(node.parent) && (ts.getModifiers(node) ?? []).some((m) => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.OverrideKeyword].includes(m.kind))) report('erasable-syntax', node.getStart(sf), `constructor parameter property ${node.name.getText(sf)}`);
      if (ts.isEnumDeclaration(node) && !(ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) report('erasable-syntax', node.getStart(sf), `enum ${node.name.text}`);
      if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name) && node.body && ts.isModuleBlock(node.body) && !(ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) && !sf.isDeclarationFile) report('erasable-syntax', node.getStart(sf), `namespace ${node.name.text}`);
      // 只含 `void e;` / `void 0;` 的 catch 等同空 catch（规避扫描器的写法；Rust 的 warn! 应改为 ctx.log 记录）。
      const onlyVoid = (b) => b.statements.length > 0 && b.statements.every((st) => ts.isExpressionStatement(st) && ts.isVoidExpression(st.expression));
      if (ts.isCatchClause(node) && (node.block.statements.length === 0 || (STRICT && onlyVoid(node.block)))) report('empty-catch', node.getStart(sf));
      if (ts.isIdentifier(node) && isDoubleIdentifier(node.text)) report('test-double', node.getStart(sf), node.text);
      if (ts.isPrivateIdentifier?.(node) && isDoubleIdentifier(node.text.slice(1))) report('test-double', node.getStart(sf), node.text);
      if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && inHost && !maySql(rel)) {
        const s = node.text ?? '';
        if (looksLikeSql(s) && !(node.parent && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)))) report('sql-outside-repository', node.getStart(sf), s.slice(0, 60).replace(/\s+/g, ' '));
      }
      if (ts.isStringLiteralLike(node) && TODO_RE.test(node.text)) report('todo-marker', node.getStart(sf), node.text.slice(0, 60));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!test) {
    // 注释中的 TODO / FIXME / unimplemented / not implemented（经 AST 取注释区间，不受字符串/正则字面量干扰）。
    const seen = new Set();
    const scanComments = (ranges) => {
      for (const r of ranges ?? []) {
        if (seen.has(r.pos)) continue;
        seen.add(r.pos);
        const t = text.slice(r.pos, r.end);
        if (TODO_RE.test(t)) report('todo-marker', r.pos, t.trim().slice(0, 60));
      }
    };
    const walkComments = (node) => {
      scanComments(ts.getLeadingCommentRanges(text, node.getFullStart()));
      scanComments(ts.getTrailingCommentRanges(text, node.getEnd()));
      ts.forEachChild(node, walkComments);
    };
    walkComments(sf);
    scanComments(ts.getLeadingCommentRanges(text, sf.endOfFileToken.getFullStart()));
  }
  return applySuppressions(dedupe(out), text).sort((a, b) => a.line - b.line || a.col - b.col);
}

/**
 * 行内豁免：违规所在行或上一行有注释 `boundary-allow <规则>[,<规则>]: <理由>`（理由必填）即豁免该规则。
 * 用于原 Rust 语义中的领域词（如 refinery 的 `Target::Fake`）；豁免数量由 boundaries.mjs 汇总输出。
 */
export const ALLOW_RE = /boundary-allow\s+([a-z-]+(?:\s*,\s*[a-z-]+)*)\s*:\s*\S/;

function applySuppressions(list, text) {
  const lines = text.split('\n');
  const allowed = (line, rule) => [lines[line - 1], lines[line - 2]].some((l) => {
    const m = l === undefined ? null : ALLOW_RE.exec(l);
    return Boolean(m && m[1].split(',').map((x) => x.trim()).includes(rule));
  });
  for (const v of list) if (allowed(v.line, v.rule)) v.suppressed = true;
  return list;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((v) => {
    const k = `${v.rule}:${v.line}:${v.col}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
