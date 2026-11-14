#!/usr/bin/env node
/**
 * 全栈插件包校验（FE-A3）：`plugin.json` 按 `plugin.schema.json` 校验，再与两半源码里的 meta 交叉核对。
 *
 * - 配对：Host 半 `definePlugin({ meta: { id } })` 与 UI 半 `defineUiPlugin({ meta: { id, host } })` 都等于包 id；
 *   有 Host 半时 UI 半必须 `host: true`（或同 id），没有 Host 半时 UI 半不得声明 `host`；
 * - 平台：Host 半 `meta.platforms`（省略即 `['desktop']`）与包的 `platforms` 相同；UI 半声明时须是其子集；
 * - 依赖：UI 半的 `requiresHost` / `requires` 与包清单一致；Host 半 `inject` 的官方服务须在 `permissions` 中声明
 *   （自己 `provides` 的除外），声明了却没注入的权限给出警告。
 *
 * 只静态读取源码（TypeScript AST），不执行插件代码。
 * 用法：node scripts/plugins/validate-package.mjs <包目录>…（有错误时退出码 1）。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Ajv2020 } from 'ajv/dist/2020.js';

export const PLUGIN_SCHEMA_PATH = fileURLToPath(new URL('./plugin.schema.json', import.meta.url));
export const pluginSchema = JSON.parse(readFileSync(PLUGIN_SCHEMA_PATH, 'utf8'));

/** Host 半省略 `meta.platforms` 时的取值（`host/profiles/platforms.ts` 的 `DEFAULT_PLUGIN_PLATFORMS`）。 */
const HOST_DEFAULT_PLATFORMS = ['desktop'];
const RESERVED_PREFIX = 'dstu.';

// strictRequired 不适用于 `anyOf: [{ required: ['host'] }, …]` 这种只列必填字段的分支。
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validateSchema = ajv.compile(pluginSchema);

// ------------------------------------------------------------------ 静态读取 meta

const DYNAMIC = Symbol('dynamic');

function unwrap(node) {
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) || ts.isTypeAssertionExpression?.(node)) node = node.expression;
  return node;
}

/** 字面量求值：字符串、数字、布尔、数组、对象，以及同文件 `const` 标识符；其余记为 DYNAMIC。 */
function literal(node, constants, depth = 0) {
  node = unwrap(node);
  if (depth > 8) return DYNAMIC;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => literal(element, constants, depth + 1));
  if (ts.isObjectLiteralExpression(node)) {
    const value = {};
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) {
        value[property.name.text] = literal(property.initializer, constants, depth + 1);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        value[property.name.text] = constants.has(property.name.text) ? literal(constants.get(property.name.text), constants, depth + 1) : DYNAMIC;
      } else if (ts.isMethodDeclaration(property) && ts.isIdentifier(property.name)) {
        value[property.name.text] = DYNAMIC;
      } else {
        return DYNAMIC;
      }
    }
    return value;
  }
  if (ts.isIdentifier(node) && constants.has(node.text)) return literal(constants.get(node.text), constants, depth + 1);
  return DYNAMIC;
}

/**
 * 读出入口文件里 `definePlugin(...)` / `defineUiPlugin(...)` 调用的 `meta` 与 `inject`。
 * 找不到调用返回 null；字段无法静态求值时为 DYNAMIC。
 */
export function readPluginMeta(text, fileName, factory) {
  const kind = /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const constants = new Map();
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isVariableDeclarationList(node.parent) && node.parent.flags & ts.NodeFlags.Const) {
      constants.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      const [arg] = node.arguments;
      if (name === factory && arg) {
        const value = literal(arg, constants);
        found = value === DYNAMIC ? { meta: DYNAMIC, inject: DYNAMIC } : { meta: value.meta ?? DYNAMIC, inject: value.inject };
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// ------------------------------------------------------------------ 校验

const isDynamic = (value) => value === DYNAMIC || (Array.isArray(value) && value.includes(DYNAMIC));
const sameSet = (a, b) => a.length === b.length && a.every((item) => b.includes(item));
const show = (value) => JSON.stringify(value);

function stringList(value) {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : DYNAMIC;
}

/** `inject` 的服务名：数组，或 `{ 服务: {...} }` 对象（与 host/kernel/profile.ts 的 dependenciesOf 一致）。 */
function injectedServices(inject) {
  if (inject === undefined) return [];
  if (Array.isArray(inject)) return inject.every((item) => typeof item === 'string') ? inject : DYNAMIC;
  if (inject && typeof inject === 'object' && inject !== DYNAMIC) return Object.keys(inject);
  return DYNAMIC;
}

/**
 * 校验一个插件包目录。返回 `{ ok, errors, warnings, manifest }`；每条问题为 `{ code, message, path? }`。
 * `options.allowOfficial` 允许 `dstu.` 前缀（官方插件包自检用）。
 */
export function validatePackage(dir, options = {}) {
  const errors = [];
  const warnings = [];
  const error = (code, message, at) => errors.push(at === undefined ? { code, message } : { code, message, path: at });
  const warn = (code, message, at) => warnings.push(at === undefined ? { code, message } : { code, message, path: at });
  const done = (manifest) => ({ ok: errors.length === 0, errors, warnings, manifest });

  const manifestPath = path.join(dir, 'plugin.json');
  if (!existsSync(manifestPath)) {
    error('manifest-missing', `${manifestPath} not found`);
    return done(undefined);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    error('manifest-json', `plugin.json is not valid JSON: ${e.message}`);
    return done(undefined);
  }
  if (!validateSchema(manifest)) {
    for (const issue of validateSchema.errors ?? []) error('schema', `${issue.instancePath || '/'} ${issue.message}`, issue.instancePath || '/');
    return done(manifest);
  }
  const { id, platforms } = manifest;
  if (id.startsWith(RESERVED_PREFIX) && !options.allowOfficial) error('id-reserved', `"${id}": the "${RESERVED_PREFIX}" prefix is reserved for official plugins`, '/id');

  const root = realpathSync(dir);
  const readEntry = (field, factory) => {
    const file = path.resolve(root, manifest[field]);
    if (!existsSync(file) || !statSync(file).isFile()) {
      error('entry-missing', `${field}: ${manifest[field]} does not exist`, `/${field}`);
      return null;
    }
    if (path.relative(root, realpathSync(file)).startsWith('..')) {
      error('entry-outside', `${field}: ${manifest[field]} resolves outside the package`, `/${field}`);
      return null;
    }
    const meta = readPluginMeta(readFileSync(file, 'utf8'), file, factory);
    if (!meta || meta.meta === DYNAMIC || typeof meta.meta !== 'object') {
      error(`${field}-meta-unreadable`, `${field}: ${manifest[field]} must default-export ${factory}({ meta: { … } }) with a literal meta`, `/${field}`);
      return null;
    }
    return meta;
  };

  // ---- Host 半
  const host = manifest.host ? readEntry('host', 'definePlugin') : null;
  if (host) {
    const { meta } = host;
    if (meta.id !== id) error('host-id-mismatch', `host: meta.id ${show(meta.id)} must equal the package id "${id}"`, '/host');
    const hostPlatforms = meta.platforms === undefined ? HOST_DEFAULT_PLATFORMS : meta.platforms;
    if (isDynamic(hostPlatforms)) {
      error('host-platforms-dynamic', 'host: meta.platforms must be a literal array', '/host');
    } else if (!sameSet(hostPlatforms, platforms)) {
      error('host-platforms-mismatch', `host: meta.platforms ${show(hostPlatforms)}${meta.platforms === undefined ? ' (default)' : ''} must equal the package platforms ${show(platforms)}`, '/platforms');
    }
    const injected = injectedServices(host.inject);
    const provided = stringList(meta.provides);
    if (injected === DYNAMIC || provided === DYNAMIC) {
      error('host-inject-dynamic', 'host: inject and meta.provides must be literal', '/host');
    } else {
      const granted = new Set((manifest.permissions ?? []).map((p) => p.slice('service:'.length)));
      for (const service of injected) {
        if (!provided.includes(service) && !granted.has(service)) error('permission-missing', `host injects service "${service}" without "service:${service}" in permissions`, '/permissions');
      }
      for (const service of granted) {
        if (!injected.includes(service)) warn('permission-unused', `permission "service:${service}" is not injected by the Host half`, '/permissions');
      }
    }
  } else if (manifest.permissions?.length && !manifest.host) {
    error('permissions-without-host', 'permissions are granted to the Host half, but the package has none', '/permissions');
  }

  // ---- UI 半
  const ui = manifest.ui ? readEntry('ui', 'defineUiPlugin') : null;
  if (ui) {
    const { meta } = ui;
    if (meta.id !== id) error('ui-id-mismatch', `ui: meta.id ${show(meta.id)} must equal the package id "${id}"`, '/ui');
    // 与 normalizeUiPluginMeta 相同：`host: true` 指与 UI 半同 id 的 Host 插件。
    const pairedTo = meta.host === true ? meta.id : meta.host;
    if (manifest.host) {
      if (pairedTo !== id) error('ui-not-paired', `ui: a package with a Host half must pair its UI half (meta.host: true), got ${show(meta.host)}`, '/ui');
    } else if (meta.host !== undefined) {
      error('ui-host-without-host-half', `ui: meta.host ${show(meta.host)} pairs a Host half, but the package has no "host" entry`, '/ui');
    }
    if (meta.platforms !== undefined) {
      if (isDynamic(meta.platforms)) error('ui-platforms-dynamic', 'ui: meta.platforms must be a literal array', '/ui');
      else if (!meta.platforms.every((p) => platforms.includes(p))) {
        error('ui-platforms-outside', `ui: meta.platforms ${show(meta.platforms)} must be a subset of the package platforms ${show(platforms)}`, '/platforms');
      }
    }
    for (const field of ['requiresHost', 'requires']) {
      const declared = stringList(meta[field]);
      const listed = manifest[field] ?? [];
      if (declared === DYNAMIC) error(`ui-${field}-dynamic`, `ui: meta.${field} must be a literal array`, '/ui');
      else if (!sameSet(declared, listed)) error(`ui-${field}-mismatch`, `ui: meta.${field} ${show(declared)} must equal plugin.json ${field} ${show(listed)}`, `/${field}`);
    }
    if (manifest.requiresHost?.includes(id)) warn('requires-host-self', `requiresHost lists the package itself; pairing already requires "${id}"`, '/requiresHost');
  } else if (!manifest.ui && (manifest.requiresHost?.length || manifest.requires?.length)) {
    error('requires-without-ui', 'requiresHost / requires describe the UI half, but the package has none', '/ui');
  }
  return done(manifest);
}

function format(dir, result) {
  const lines = [`${dir}: ${result.ok ? 'ok' : `${result.errors.length} error(s)`}${result.warnings.length ? `, ${result.warnings.length} warning(s)` : ''}`];
  for (const e of result.errors) lines.push(`  error   [${e.code}] ${e.message}`);
  for (const w of result.warnings) lines.push(`  warning [${w.code}] ${w.message}`);
  return lines.join('\n');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const allowOfficial = process.argv.includes('--allow-official');
  if (!dirs.length) {
    console.error('usage: node scripts/plugins/validate-package.mjs [--allow-official] <package-dir>...');
    process.exit(2);
  }
  let failed = false;
  for (const dir of dirs) {
    const result = validatePackage(dir, { allowOfficial });
    console.log(format(dir, result));
    failed ||= !result.ok;
  }
  process.exit(failed ? 1 : 0);
}
