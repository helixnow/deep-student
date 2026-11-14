#!/usr/bin/env node
/**
 * 插件能力目录生成器。
 *
 * 从 host/plugins 各插件 index.ts 的 meta、各 api.ts 的 `declare module` 服务声明、
 * inject / ctx.get 依赖、contracts/ipc/*.json 的事件，生成 docs/plugins/CAPABILITIES.md。
 *
 *   node scripts/plugin-catalog/generate.mjs            # 重新生成
 *   node scripts/plugin-catalog/generate.mjs --check    # 漂移检测（CI 用）
 *
 * 目录只做静态分析：不执行插件模块源码，避免各 lane 的构造参数属性等
 * 非擦除语法影响生成器，也避免加载原生依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGINS = path.join(ROOT, 'host/plugins');
const PLATFORM = path.join(ROOT, 'host/platform');
const CONTRACTS = path.join(ROOT, 'contracts/ipc');
const OUT = path.join(ROOT, 'docs/plugins/CAPABILITIES.md');

const KERNEL_SERVICES = [
  ['app', 'AppInfo：应用信息（dataDir、version、platform、debug）'],
  ['commands', 'CommandRegistry：Tauri 命令注册与调用'],
  ['backendEvents', 'BackendEventService：Rust app.emit / app.listen'],
  ['protocols', 'ProtocolService：自定义协议注册'],
  ['shell', 'ShellService：请求 Electron main 执行外壳操作'],
];

const isTestFile = (file) =>
  /\.test\.ts$/.test(file) || /\.spec\.ts$/.test(file) || /(^|\/)(tests|__tests__|__fixtures__)\//.test(file);

const rel = (file) => path.relative(ROOT, file).replaceAll('\\', '/');

// ---------------------------------------------------------------- TS 解析

function readSource(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** 求值对象/数组字面量；支持顶层 const、as const、括号。 */
function evalLiteral(node, sf) {
  if (!node) return undefined;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return evalLiteral(node.expression, sf);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => evalLiteral(element, sf));
  if (ts.isObjectLiteralExpression(node)) {
    const object = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : property.name.getText(sf);
      object[key] = evalLiteral(property.initializer, sf);
    }
    return object;
  }
  if (ts.isIdentifier(node)) {
    for (const statement of sf.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === node.text) {
          return evalLiteral(declaration.initializer, sf);
        }
      }
    }
  }
  return undefined;
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

/** 读取 index.ts 的 definePlugin 字面量；index.ts 可以是 `export { default } from './impl.ts'` 的转发。 */
function parsePluginEntry(file, optional = false) {
  let sourceFile = file;
  const text = fs.readFileSync(file, 'utf8');
  const forward = /export\s*\{\s*default\s*\}\s*from\s*['"](\.[^'"]+)['"]/.exec(text);
  if (forward && !text.includes('definePlugin(')) {
    const target = path.resolve(path.dirname(file), forward[1]);
    if (fs.existsSync(target)) sourceFile = target;
  }
  const sf = readSource(sourceFile);
  const call = findDefinePlugin(sf);
  if (call === null) {
    if (optional) return null;
    throw new Error(`${rel(file)}: no definePlugin(...) call`);
  }
  const literal = evalLiteral(call.arguments[0], sf);
  if (literal === undefined || typeof literal !== 'object') throw new Error(`${rel(file)}: definePlugin argument is not a static object`);
  const meta = literal.meta ?? {};
  return {
    id: String(meta.id ?? ''),
    lane: typeof meta.lane === 'string' ? meta.lane : null,
    commands: Array.isArray(meta.commands) ? meta.commands.filter((name) => typeof name === 'string') : [],
    provides: Array.isArray(meta.provides) ? meta.provides.filter((name) => typeof name === 'string') : [],
    inject: Array.isArray(literal.inject) ? literal.inject.filter((name) => typeof name === 'string') : [],
    file,
    dir: path.dirname(file),
    kind: file.startsWith(PLATFORM + path.sep) ? 'platform' : 'plugin',
  };
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

const pluginEntries = listDirs(PLUGINS)
  .map((dir) => path.join(PLUGINS, dir, 'index.ts'))
  .filter((file) => fs.existsSync(file))
  .map((file) => parsePluginEntry(file));
const platformEntries = listDirs(PLATFORM)
  .map((dir) => path.join(PLATFORM, dir, 'index.ts'))
  .filter((file) => fs.existsSync(file))
  .map((file) => parsePluginEntry(file, true))
  .filter((entry) => entry !== null);
const entries = [...pluginEntries, ...platformEntries];

for (const entry of entries) {
  if (!entry.id) throw new Error(`${rel(entry.file)}: meta.id is missing or not a string literal`);
}

const entryById = new Map(entries.map((entry) => [entry.id, entry]));

// 服务声明（插件 + 平台，含 native/* 等嵌套 api.ts）。
const declarations = [];
for (const dir of [...listDirs(PLUGINS).map((name) => path.join(PLUGINS, name)), ...listDirs(PLATFORM).map((name) => path.join(PLATFORM, name))]) {
  if (!fs.existsSync(dir)) continue;
  for (const api of walkTs(dir).filter((file) => path.basename(file) === 'api.ts')) {
    declarations.push(...parseServiceDeclarations(api));
  }
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
  for (const file of walkTs(entry.dir)) {
    if (isTestFile(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:\bctx|\bthis\.ctx)\.get(?:<[^>]*>)?\(\s*['"]([^'"]+)['"]/g)) {
      if (/^<.*>$/.test(match[1]) || /\s/.test(match[1])) continue; // 文档占位符，如 ctx.get('<service>')
      addTo(optionalConsumers, match[1], entry.id);
    }
    for (const match of text.matchAll(/(?:\bctx|\bthis\.ctx)\.(?:reflect\.)?provide\(\s*['"]([^'"]+)['"]/g)) {
      addTo(runtimeProvides, match[1], entry.id);
    }
    for (const match of text.matchAll(/super\(\s*ctx\s*,\s*['"]([^'"]+)['"]/g)) {
      addTo(runtimeProvides, match[1], entry.id);
    }
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

// 跨插件 import：是否绕过 api.ts。
function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const importIssues = [];
for (const entry of entries) {
  for (const file of walkTs(entry.dir)) {
    if (isTestFile(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const target = resolveImport(file, match[1] ?? match[2]);
      if (target === null) continue;
      const targetRel = rel(target);
      const pluginMatch = /^host\/plugins\/([^/]+)\//.exec(targetRel);
      if (pluginMatch === null || pluginMatch[1] === path.basename(entry.dir)) continue;
      if (targetRel.endsWith('/api.ts')) continue;
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
const unresolvedConsumers = services.filter((service) => service.status === 'unresolved');

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

// 命令：声明了但契约里没有。
const unknownCommands = [];
for (const entry of entries) {
  for (const command of entry.commands) {
    if (!contractCommands.has(command)) unknownCommands.push({ id: entry.id, command });
  }
}
const duplicateCommands = [];
{
  const owners = new Map();
  for (const entry of entries) for (const command of entry.commands) addTo(owners, command, entry.id);
  for (const [command, ids] of owners) if (ids.length > 1) duplicateCommands.push({ command, ids });
}

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
  const usedPlugins = new Set();
  const edges = new Set();
  const serviceNodes = services.filter((service) => !service.kernel);
  for (const entry of entries) {
    lines.push(`  ${nodeId('p', entry.id)}["${entry.id}"]:::plugin`);
    usedPlugins.add(entry.id);
  }
  for (const service of serviceNodes) {
    const id = nodeId('s', service.name);
    lines.push(`  ${id}(["${service.name}"]):::${service.status === 'missing' || service.status === 'unresolved' ? 'missing' : 'service'}`);
    for (const provider of service.providers) {
      const edge = `  ${nodeId('p', provider)} -->|provides| ${id}`;
      if (!edges.has(edge)) lines.push(edge), edges.add(edge);
    }
    for (const consumer of service.required) {
      const edge = `  ${id} -->|inject| ${nodeId('p', consumer)}`;
      if (!edges.has(edge)) lines.push(edge), edges.add(edge);
    }
    for (const consumer of service.optional) {
      const edge = `  ${id} -.->|get| ${nodeId('p', consumer)}`;
      if (!edges.has(edge)) lines.push(edge), edges.add(edge);
    }
  }
  lines.push('```');
  return lines;
}

function render() {
  const pluginCount = pluginEntries.length;
  const platformCount = platformEntries.length;
  const commandCount = entries.reduce((sum, entry) => sum + entry.commands.length, 0);
  const serviceCount = services.filter((service) => !service.kernel).length;
  const missing = services.filter((service) => service.status === 'missing');
  const undeclared = services.filter((service) => service.status === 'undeclared');
  const duplicates = services.filter((service) => service.status === 'duplicate');

  const lines = [];
  lines.push('# 插件能力清单（Capability Seams）');
  lines.push('');
  lines.push('> 自动生成，请勿手改：`node scripts/plugin-catalog/generate.mjs`。CI 用 `--check` 检测漂移。');
  lines.push('> 与 DeepSeek Harness 的 `docs/capability-seams.md` 对齐：服务是插件之间唯一的跨 lane 编程接口，');
  lines.push('> 命令与事件是面向 UI/main 的线缆。插件编写指南见 `docs/plugins/SDK.md`。');
  lines.push('');
  lines.push(`统计：${pluginCount} 个业务插件、${platformCount} 个平台插件、${serviceCount} 个服务 seam、`
    + `${commandCount} 条命令、${contractEvents.length} 个契约事件。`);
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
    entry.kind === 'platform' ? '平台' : '业务',
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

  lines.push(`### 5.6 绕过 api.ts 的跨插件 import（${importIssues.length}）`);
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

  lines.push(`### 5.7 命令声明与契约（未知 ${unknownCommands.length}，重复 ${duplicateCommands.length}）`);
  lines.push('');
  if (unknownCommands.length === 0 && duplicateCommands.length === 0) lines.push('无。');
  else {
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
  }
  lines.push('');

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
  lines.push('- 新增/删除服务、命令、事件后运行 `node scripts/plugin-catalog/generate.mjs`，把结果与源码一起提交。');
  lines.push('- CI 运行 `node scripts/plugin-catalog/generate.mjs --check`；文档与源码不一致时退出码 1。');
  lines.push('- 服务接口以 `contracts/services/` 的草稿为评审依据；发布后消费方只从提供方 `api.ts` 导入类型。');
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
  console.log('usage: node scripts/plugin-catalog/generate.mjs [--check]');
  process.exit(0);
}

if (args.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (current === content) {
    console.log('plugin-catalog: OK');
    process.exit(0);
  }
  if (current === null) {
    console.error(`plugin-catalog: ${rel(OUT)} is missing; run node scripts/plugin-catalog/generate.mjs`);
  } else {
    const expected = content.split('\n');
    const actual = current.split('\n');
    let line = 0;
    while (line < expected.length && line < actual.length && expected[line] === actual[line]) line += 1;
    console.error(`plugin-catalog: ${rel(OUT)} is stale at line ${line + 1}; run node scripts/plugin-catalog/generate.mjs`);
    console.error(`  expected: ${JSON.stringify(expected[line] ?? '<EOF>')}`);
    console.error(`  actual:   ${JSON.stringify(actual[line] ?? '<EOF>')}`);
  }
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, content);
console.log(`plugin-catalog: wrote ${rel(OUT)} (${content.split('\n').length} lines)`);
