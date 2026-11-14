import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProgram, scanProgram, shellRoutes, type Site } from './scan.ts';
import { loadRegistry, type Registry } from './registry.ts';
import { compareShapes, resolveSchema, type Schema } from './schema.ts';

export interface Finding { lane: string; code: string; name: string; detail: string; sites: string[]; severity: 'error' | 'review' | 'info' }
export interface ContractDoc extends Schema { lane: string; commands?: any[]; events?: any[] }
export function matches(a: string, b: string): boolean {
  if (a.startsWith('{}') || b.startsWith('{}')) return false;
  const regex = (s: string) => new RegExp('^' + s.split('{}').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+') + '$');
  return a === b || regex(a).test(b) || regex(b).test(a);
}
const location = (s: Site) => `${s.file}:${s.line}`;

export function reconcile(sites: Site[], hostSites: Site[], registry: Registry, documents: Map<string, ContractDoc>, fallbackLane: (name: string) => string = () => 'UNASSIGNED') {
  hostSites = hostSites.filter(s => !s.test);
  const findings: Finding[] = [];
  const add = (lane: string, code: string, name: string, detail: string, at: string[], severity: Finding['severity'] = 'error') => {
    const old = findings.find(f => f.lane === lane && f.code === code && f.name === name && f.detail === detail);
    if (old) old.sites = [...new Set([...old.sites, ...at])].sort();
    else findings.push({ lane, code, name, detail, sites: at, severity });
  };
  const commands = new Map<string, { command: any; doc: ContractDoc }>();
  const events: { event: any; doc: ContractDoc }[] = [];
  for (const doc of documents.values()) {
    for (const command of doc.commands ?? []) commands.set(command.name, { command, doc });
    for (const event of doc.events ?? []) events.push({ event, doc });
  }
  const owners = new Map<string, typeof registry.plugins>();
  const shell = new Map((registry.shellRoutes ?? []).map(r => [r.command, r]));
  for (const plugin of registry.plugins) {
    if (plugin.error) add(plugin.lane, 'host-load-failed', plugin.id, plugin.error, [plugin.file]);
    for (const name of plugin.commands) owners.set(name, [...(owners.get(name) ?? []), plugin]);
  }
  const laneOf = (name: string) => commands.get(name)?.doc.lane ?? owners.get(name)?.[0]?.lane ?? fallbackLane(name);
  const missingHost = new Set<string>(), missingContract = new Set<string>();
  for (const [name, plugins] of owners) {
    const ownerLane = plugins[0]?.lane ?? laneOf(name);
    if (!commands.has(name) && plugins.some(p => p.basis === 'kernel-registration')) {
      add(ownerLane, 'platform-extension-without-rust-contract', name, 'actual kernel-owned registration; intentionally outside Rust app-command contracts', plugins.map(p => p.file), 'info');
    } else if (!commands.has(name)) {
      missingContract.add(name); add(ownerLane, 'host-command-without-contract', name, 'runtime meta.commands has no authoritative Rust contract', plugins.map(p => p.file));
    }
    if (plugins.length > 1) add(laneOf(name), 'duplicate-host-command', name, plugins.map(p => p.id).join(', '), plugins.map(p => p.file));
  }
  const production = sites.filter(s => !s.test);
  const invoke = production.filter(s => s.kind === 'invoke');
  const subscribed = production.filter(s => s.kind === 'listen' || s.kind === 'once');
  const emitted = production.filter(s => s.kind === 'emit');
  const frontendCommands = new Set(invoke.flatMap(s => s.names.filter(n => !n.includes('{}'))));
  for (const s of invoke) for (const name of s.names) {
    if (name.includes('{}')) { add('DYNAMIC', 'dynamic-command', name, s.expression, [location(s)], 'review'); continue; }
    const lane = laneOf(name);
    if (!owners.has(name) && !shell.has(name)) {
      missingHost.add(name);
      const offProfile = registry.unprofiled?.find(p => p.commands.includes(name));
      add(lane, 'frontend-command-not-in-host-meta', name, offProfile ? `implementation module ${offProfile.file} declares it, but the official Host profile does not load that module` : registry.plugins.some(p => p.error) ? 'absent from successfully imported profile metadata; failed imports must be resolved before asserting absence' : 'absent from all runtime-loaded desktop profile metadata', [location(s)]);
    }
    const contract = commands.get(name);
    if (!contract && (shell.has(name) || owners.get(name)?.some(p => p.basis === 'kernel-registration'))) {
      if (shell.has(name)) { const route = shell.get(name)!; add('F2-shell', 'shell-command-outside-rust-contract', name, 'Electron main registers a built-in plugin route (static source evidence, not Host metadata)', [location(s), `${route.file}:${route.line}`], 'info'); }
      continue;
    }
    if (!contract) { add(lane, 'frontend-command-without-contract', name, name.startsWith('plugin:') ? 'plugin/platform command outside extracted app-command contract' : 'no authoritative Rust command contract', [location(s)], name.startsWith('plugin:') ? 'review' : 'error'); continue; }
    const { command, doc } = contract;
    if (command.args.length === 0 && command.injected?.some((i: any) => i.kind === 'request')) {
      add(lane, 'raw-body-command', name, 'Rust Request receives raw body; args-key comparison does not apply; body/header equivalence requires handler review', [location(s)], 'review');
      continue;
    }
    const args = new Map<string, any>(command.args.map((a: any) => [a.key, a]));
    const props = s.shape.properties ?? {};
    if (!s.shape.type || s.shape['x-open']) add(lane, 'argument-shape-unresolved', name, `cannot prove exact argument keys: ${s.tsType}${s.shape['x-transform'] ? `; wrapper transforms payload: ${s.shape['x-transform']}` : ''}`, [location(s)], 'review');
    for (const [key, shape] of Object.entries(props)) {
      const arg = args.get(key);
      if (!arg) {
        const similar = command.args.find((a: any) => a.rustName === key || a.key.replaceAll('_', '').toLowerCase() === key.replaceAll('_', '').toLowerCase());
        const redundant = similar && Object.hasOwn(props, similar.key);
        add(lane, redundant ? 'argument-redundant-alias' : similar ? 'argument-case-mismatch' : 'argument-extra-key', name, similar ? `${key} != ${similar.key} (Rust ${similar.rustName}); ${redundant ? 'correct key is also supplied; Tauri ignores this extra alias' : 'only the exact contract key is read by Tauri'}` : `${key}: not a command argument (Tauri ignores extra top-level keys)`, [location(s)], similar && !redundant ? 'error' : 'review');
      } else {
        const deref = (v: Schema) => resolveSchema(v, doc, documents);
        for (const p of compareShapes(shape as Schema, arg.schema, key, deref)) add(lane, 'argument-shape-mismatch', name, `${p.path}: ${p.reason}`, [location(s)]);
      }
    }
    if (s.shape.type === 'object' && !s.shape['x-open']) for (const arg of command.args) if (!arg.optional && !Object.hasOwn(props, arg.key)) add(lane, 'argument-missing-key', name, `missing ${arg.key} (Rust ${arg.rustName})`, [location(s)]);
    const registrations = hostSites.filter(h => h.kind === 'register' && h.names.includes(name));
    for (const h of registrations) {
      // Kernel checkArgs materializes every top-level Option key as null; this
      // is the handler input, unlike the optional frontend wire key.
      const expected: Schema = { type: 'object', properties: Object.fromEntries(command.args.map((a: any) => [a.key, a.schema])), required: command.args.map((a: any) => a.key) };
      for (const p of compareShapes(expected, h.shape, 'hostArgs', v => resolveSchema(v, doc, documents))) add(lane, 'host-handler-shape-mismatch', name, `${p.path}: ${p.reason} (TS annotation mismatch; not proof of runtime rejection)`, [location(h)], 'review');
    }
  }
  const matchedEvents = new Set<string>(), missingEvents = new Set<string>();
  for (const s of [...subscribed, ...emitted]) for (const name of s.names) {
    if (name.startsWith('{}')) { add(s.file.includes('menuEventBridge') ? 'F2-shell' : s.file.includes('NoTagTreeShadPanel') ? 'L17-memory-research' : 'DYNAMIC', 'event-name-unresolved', name, s.expression, [location(s)], 'review'); continue; }
    const exact = events.filter(e => e.event.name === name);
    const candidates = exact.length ? exact : events.filter(e => matches(e.event.name, name));
    const host = hostSites.filter(h => h.kind === (s.kind === 'emit' ? 'host-listen' : 'host-emit') && h.names.some(n => n !== '{}' && matches(n, name)));
    const lane = candidates[0]?.doc.lane ?? 'UNASSIGNED';
    if (!candidates.length) { missingEvents.add(name); add(lane, 'event-without-contract', name, s.kind === 'emit' ? 'frontend emission; Rust extraction catalogs backend emitters, not frontend listeners' : 'no matching Rust backend event contract', [location(s)], name.startsWith('tauri://') || s.kind === 'emit' ? 'review' : 'error'); }
    else matchedEvents.add(name);
    if (candidates.length > 1) { add(lane, 'event-contract-ambiguous', name, `${candidates.length} possible Rust event contracts; payload comparison deferred until channel is resolved`, [location(s)], 'review'); continue; }
    if (!host.length) add(lane, s.kind === 'emit' ? 'host-event-listener-unproven' : 'host-event-emitter-unproven', name, 'no statically resolved Host BackendEvents endpoint; indirect/custom emitters require review (not proof of absence)', [location(s)], 'review');
    if (!s.shape.type && !s.shape.anyOf) add(lane, 'event-payload-unresolved', name, `frontend payload ${s.tsType}`, [location(s)], 'review');
    for (const { event, doc } of candidates) {
      const deref = (v: Schema) => resolveSchema(v, doc, documents);
      const source = s.kind === 'emit' ? s.shape : event.payload;
      const target = s.kind === 'emit' ? event.payload : s.shape;
      // Multiple event variants are alternatives, not independent guaranteed schemas.
      for (const p of compareShapes(source, target, 'payload', deref)) add(lane, 'event-payload-mismatch', name, `${p.path}: ${p.reason}`, [location(s)]);
      for (const h of host) for (const p of compareShapes(h.shape, event.payload, 'hostPayload', deref)) add(lane, 'host-event-payload-mismatch', name, `${p.path}: ${p.reason}`, [location(h)]);
    }
  }
  findings.sort((a, b) => a.lane.localeCompare(b.lane) || a.code.localeCompare(b.code) || a.name.localeCompare(b.name) || a.detail.localeCompare(b.detail));
  return {
    stats: {
      totalSites: sites.length, productionSites: production.length, testSites: sites.filter(s => s.test).length,
      invokeSites: invoke.length, listenSites: subscribed.length, emitSites: emitted.length,
      frontendCommands: frontendCommands.size, contractCommands: commands.size, hostCommands: owners.size,
      frontendCommandsInContract: [...frontendCommands].filter(n => commands.has(n)).length,
      frontendCommandsInHostMeta: [...frontendCommands].filter(n => owners.has(n)).length,
      frontendCommandsWithShellRoute: [...frontendCommands].filter(n => shell.has(n)).length,
      frontendCommandsMissingHostMeta: missingHost.size, hostCommandsMissingContract: missingContract.size,
      frontendEventNames: new Set([...subscribed, ...emitted].flatMap(s => s.names)).size,
      contractEvents: events.length, matchedEventNames: matchedEvents.size, eventNamesWithoutContract: missingEvents.size,
      contractEventNames: new Set(events.map(e => e.event.name)).size,
      hostEventSites: hostSites.filter(s => s.kind.startsWith('host-')).length,
      loadedPlugins: registry.plugins.filter(p => !p.error).length, failedPlugins: registry.plugins.filter(p => p.error).length,
      kernelCommandsActuallyRegistered: registry.plugins.filter(p => p.basis === 'kernel-registration').flatMap(p => p.commands).length,
      errors: findings.filter(f => f.severity === 'error').length, review: findings.filter(f => f.severity === 'review').length,
      info: findings.filter(f => f.severity === 'info').length,
    }, findings,
  };
}

export function renderReport(result: any): string {
  const { stats, findings } = result;
  const lines = ['# X2-frontend-contracts：前后端契约对账', '', `源码快照：\`${result.commit}\`；工具 schemaVersion=${result.schemaVersion}。`, '',
    '## 结论与边界', '',
    '**不通过**：此报告是调用面/结构对账，不是命令业务语义严格等价的证明。未改动前端或插件。',
    'Host 插件命令来源为实际动态 import desktop profile 后取得的 `meta.commands`（runtime-meta），未执行插件 apply、未启动数据库或业务服务；不能把声明视为注册成功。另创建无插件、无数据库的真实 HostRuntime，读取内核实际注册的 plugin:* 命令。Electron main 的内置插件路由通过 registerPlugin(factory()) AST 边提取，标记为静态证据，不冒充 Host 元数据。静态 register/BackendEvents（不含测试）证据另列于 JSON。加载失败、动态命令与无法推断项均不计为通过。',
    'Tauri 2：权威契约 args[].key 已按 tauri-macros 2.6.3/heck 0.5 转换；只精确匹配 key，不把 snake_case/camelCase 视为同义。`rename_all="snake_case"` 以契约 key 为准；嵌套结构不转换。额外顶层键 Tauri 会忽略，列 review，不误报为调用必败。',
    'AST 遍历全部 src（含测试，测试单列不参与门禁）；识别静态/动态 import（含 then 与懒加载工厂）、别名、namespace、接口 invoke 注入，固定点推导转发封装的命令与参数位置，支持绑定参数及 payload 转换（后者明确标记 x-transform，不能声称完整键集已知）。eventHub 缓存表间接订阅另有人工核实的声明级摘要（hubListen 名称 0/handler 1；hubListenKeyed 名称 0/handler 2；registerDomainListener 名称 0/handler 1，均 raw payload；证据 src/features/workbench/core/eventHub.ts:106-117,153-184 与 agent/domainEvents.ts:312-350）。固定命令的 API/TauriAdapter 方法在其内部 invoke 点计一次，不按每个业务调用者重复展开。字符串常量/有限联合/对象命令表/条件/模板/单 return 名称工厂可展开；其余以 {} 标记动态部分，裸 {} 从不当作全事件通配。',
    '类型由 TS checker（strictNullChecks=true，保留可空性）推断。JSON shape 深度 6，递归/any/unknown/索引签名显式保留；未知不是通过证据。结构比较检查必需字段与原始类型，不证明运行时值、所有 enum 分支或整数精度。Host 顶层 Option 参数按真实 kernel/contracts.ts:218-240 补 null 后比较；TS handler 注解差异列 review，不据此断言运行时拒绝。Host 事件为静态端点证据，不执行流式业务；未解析自定义 emitter 不宣称缺失。SDK 包内部隐式 IPC 不属于 src 内显式调用点计数。', '',
    '## 运行', '', '```sh',
    'npx vitest run -c vitest.host.config.ts scripts/electron-migration/frontend-audit',
    'node scripts/electron-migration/frontend-audit/audit.ts',
    'node scripts/electron-migration/frontend-audit/audit.ts --check', '```', '',
    '普通模式写本报告与 `scripts/electron-migration/frontend-audit/result.json`；`--check` 只读、重新对账，error 或 review 任一存在退出 1，工具故障退出 2，不使用当前问题作为豁免基线。info 为已定位的平台扩展而非 Rust 契约缺漏，不单独阻断。Node >= 24（原生 TS 类型擦除），依赖仓库 TypeScript。', '',
    '## 统计', '', '| 指标 | 数量 |', '|---|---:|',
    ...Object.entries(stats).map(([k, v]) => `| ${k} | ${v} |`), '',
    `发现封装 ${result.frontend.wrappers.length} 个；底层转发点 ${result.frontend.forwarding.length} 个（不重复计业务调用）；未归入 IPC 的同名候选 ${result.frontend.candidates.length} 个，全部保留在 JSON 供复查。`, '',
    '## 按 lane 汇总', '', '| lane | error | review | info |', '|---|---:|---:|---:|',
  ];
  const lanes = [...new Set<string>(findings.map((f: Finding) => f.lane))].sort();
  for (const lane of lanes) lines.push(`| ${lane} | ${findings.filter((f: Finding) => f.lane === lane && f.severity === 'error').length} | ${findings.filter((f: Finding) => f.lane === lane && f.severity === 'review').length} | ${findings.filter((f: Finding) => f.lane === lane && f.severity === 'info').length} |`);
  lines.push('', '## 不一致清单（按 lane，前 30 条）', '', '| lane | 类别 | 命令/事件 | 问题 | 证据 |', '|---|---|---|---|---|');
  for (const f of findings.filter((f: Finding) => f.severity !== 'info').slice(0, 30)) lines.push(`| ${f.lane} | ${f.code} | ${f.name.replaceAll('|', '\\|')} | ${f.detail.replaceAll('|', '\\|')} | ${f.sites.slice(0, 2).join(', ')} |`);
  lines.push('', '完整逐条清单见 result.json 的 findings（按 lane/code/name 排序）；下列为分组摘要，便于协调者分发。', '');
  for (const lane of lanes) {
    lines.push(`### ${lane}`, '');
    const group = findings.filter((f: Finding) => f.lane === lane);
    for (const code of [...new Set<string>(group.map((f: Finding) => f.code))]) {
      const subset = group.filter((f: Finding) => f.code === code);
      lines.push(`- **${code}**（${subset.length}）：${[...new Set<string>(subset.map((f: Finding) => f.name))].slice(0, 12).map(n => `\`${n}\``).join('、')}${subset.length > 12 ? ' …（完整见 JSON）' : ''}`);
    }
    lines.push('');
  }
  lines.push('## 动态命令/事件人工分类', '', '下表逐点列出；有限命令联合已展开为静态名称，不在此重复。`{}` 不是通配豁免，未穷举命令保持 review。', '', '| 位置 | 种类 | 表达式 | 分类 | 归一化名称 |', '|---|---|---|---|---|');
  for (const d of result.dynamic) lines.push(`| ${d.file}:${d.line} | ${d.kind} | ${d.expression.replaceAll('|', '\\|').replaceAll('\n', ' ')} | ${d.classification} | ${d.names.join(', ')} |`);
  lines.push('', '### 已穷举的计算型命令名', '', '| 位置 | 表达式 | 人工分类 | 命令全集 |', '|---|---|---|---|');
  for (const d of result.computedCommands ?? []) lines.push(`| ${d.file}:${d.line} | ${d.expression.replaceAll('|', '\\|').replaceAll('\n', ' ')} | ${d.classification} | ${d.names.join(', ').replaceAll('|', '\\|')} |`);
  lines.push('', '## 封装入口（AST 推导参数位置，0-based；-1 为内部绑定参数）', '', '| 位置 | 封装 | 操作 | 名称参数 | 数据/handler 参数 |', '|---|---|---|---:|---:|');
  for (const w of result.frontend.wrappers) lines.push(`| ${w.file}:${w.line} | ${w.name} | ${w.kind} | ${w.nameIndex} | ${w.dataIndex} |`);
  return lines.join('\n') + '\n';
}

export function classifyDynamic(s: Site): string {
  if (s.kind === 'invoke' && !s.dynamic) return s.file.includes('taskControl') ? '文档任务 pause/resume/cancel 的有限动作表，已穷举' : s.file.includes('IndexMaintenanceSection') ? 'chat/vfs 两个索引维护操作（按钮及 optimizeAll 表），已穷举' : '静态常量/有限类型或命令表，已穷举名称（不是未知运行时路由）';
  if (s.file.includes('NoTagTreeShadPanel')) return 'X2-R06：历史 undefined preview 命令先 await、失败后 catch，当前 Rust 路径在订阅前失败；成功通道仍 unproven，不向 L17 新派生成/发射任务（见 REVIEW.md）';
  if (s.file.includes('menuEventBridge')) return 'macOS 菜单 handlers 表的键（buildHandlers）；交 F2-shell 核对 menu 事件集合';
  if (s.file.includes('demo/')) return '演示包模拟后端发射；纳入扫描但不等同于 Host 发射实现';
  if (s.file.includes('domainEvents')) return '领域事件注册表转发；上游有 todo/qbank/review/fsrs/memory/dstu 多 lane，未知名称不当作全部事件';
  if (s.kind !== 'invoke') return s.names.some(n => n !== '{}') ? '按会话/任务 ID 生成的事件通道；按模式对账' : '事件转发/注册表取名；需枚举上游注册表';
  if (/browser/i.test(s.file)) return 'Browser 运行时命令路由；需核对调用者允许集合';
  if (/debug|test/i.test(s.file)) return '调试/测试命令转发（仍为生产 src，非自动豁免）';
  if (/plugin|ui-kernel/i.test(s.file)) return '插件桥命令；独立于 Rust app-command 契约';
  return '运行时命令转发/注入；需人工核对上游命令集合';
}

async function main() {
  const root = process.cwd();
  const args = process.argv.slice(2);
  if (args.some(a => a !== '--check')) throw new Error('usage: node scripts/electron-migration/frontend-audit/audit.ts [--check]');
  const program = createProgram(root);
  console.error('frontend-audit: scanning frontend AST and wrapper signatures');
  const frontend = scanProgram(program, root);
  console.error(`frontend-audit: ${frontend.sites.length} frontend sites; scanning Host endpoints`);
  const host = scanProgram(program, root, 'host');
  console.error(`frontend-audit: ${host.sites.length} Host endpoints; importing desktop profile metadata (no apply)`);
  const registry = loadRegistry(root);
  registry.shellRoutes = shellRoutes(program, root);
  console.error(`frontend-audit: ${registry.plugins.length} profile modules; reconciling contracts`);
  const dir = path.join(root, 'contracts/ipc');
  const documents = new Map<string, ContractDoc>(fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => [f, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]));
  const reconciled = reconcile(frontend.sites, host.sites, registry, documents, name => name.startsWith('plugin:host|') ? 'F1-kernel' : name.startsWith('plugin:') ? 'F2-shell' : 'UNASSIGNED');
  const result = { schemaVersion: 1, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), ...reconciled, registry, frontend, host,
    dynamic: frontend.sites.filter(s => s.dynamic && !s.test).map(s => ({ ...s, classification: classifyDynamic(s) })),
    computedCommands: frontend.sites.filter(s => s.kind === 'invoke' && !s.dynamic && !s.test && !/^(['"])[\s\S]*\1$/.test(s.expression)).map(s => ({ ...s, classification: classifyDynamic(s) })),
  };
  if (!args.includes('--check')) {
    fs.mkdirSync(path.join(root, 'docs/dev/electron-migration/audits'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts/electron-migration/frontend-audit/result.json'), JSON.stringify(result, null, 2) + '\n');
    fs.writeFileSync(path.join(root, 'docs/dev/electron-migration/audits/X2-frontend-contracts.md'), renderReport(result));
  }
  console.log(JSON.stringify({ stats: result.stats, mode: registry.mode, check: args.includes('--check') }, null, 2));
  if (args.includes('--check') && (result.stats.errors || result.stats.review)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exitCode = 2; });
