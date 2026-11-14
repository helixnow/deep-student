// 抽取主流程：加载工作区 → 命令 → 事件（含包装函数多轮传播）→ 定义命名/去重/分 lane → 产物文本。
import { loadRustParser } from './ts.ts';
import { loadRust, type Workspace } from './workspace.ts';
import { Resolver } from './resolve.ts';
import { SchemaBuilder, TypeResolver, REF_PREFIX, type Owner, type UnresItem, type DefInstance } from './schema.ts';
import { allFns, extractCommand, type CommandOut } from './commands.ts';
import { EventAnalyzer, exprText, jsonLitSchema, type EmitRecord, type PayloadRes, type Wrapper } from './events.ts';
import { laneOfCommand, laneOfFile, loadLaneRules, type LaneRules } from './lanes.ts';
import { renderOutputs } from './output.ts';
import { GitHeadSource, type SourceTree } from './source.ts';
import { HANDLER_FILE, parseGenerateHandler } from './handlers.ts';
import { HOST_NATIVE_JSON, loadHostNative, type HostNative } from './host-native.ts';
import type { FnDef } from './model.ts';
import type { JsonSchema } from '../../../../host/kernel/contract.ts';

/** 抽取器版本：改动输出语义时递增，`--check` 据此判断契约是否过期。 */
export const GENERATOR = 'deep-student/contracts-extract@1.6.0';

export interface InventoryCommand { name: string; file: string; line: number; lane: string; frontend: 'app' | 'demo-only' | 'none' }

export interface EventOut {
  record: EmitRecord;
  lane: string;
  owner: Owner;
  payload: JsonSchema;
}

export interface SkippedEmit { file: string; line: number; fn: string; reason: string; lane: string }

export interface Extraction {
  ws: Workspace;
  sb: SchemaBuilder;
  /** `registered`：是否列在 lib.rs 的 generate_handler! 中；找不到注册表时为 null（不下结论）。 */
  commands: (CommandOut & { lane: string; frontend: 'app' | 'demo-only' | 'none'; inInventory: boolean; registered: boolean | null })[];
  events: EventOut[];
  skippedEmits: SkippedEmit[];
  inventory: InventoryCommand[];
  inactiveCommands: { file: string; line: number; name: string; lane: string }[];
  rules: LaneRules;
  hostNative: HostNative | null;
}

const fnLabel = (fn: FnDef): string => fn.name;

export const INVENTORY_JSON = 'docs/dev/electron-migration/inventory/commands.json';

export async function extract(src: SourceTree): Promise<Extraction> {
  const rustDir = 'src-tauri';
  const parser = await loadRustParser();
  const rules = loadLaneRules(src);
  const inventory = (src.exists(INVENTORY_JSON) ? JSON.parse(src.read(INVENTORY_JSON)) : []) as InventoryCommand[];

  // 包装函数传播需要调用点；调用点只为已知包装函数名记录，故按需重载（通常 2–3 轮）。
  let callNames = new Set<string>();
  let ws: Workspace;
  let round = 0;
  let pass: ReturnType<typeof analyzeEvents>;
  for (;;) {
    ws = loadRust(parser, src, rustDir, { callNames });
    const r = new Resolver(ws);
    const tr = new TypeResolver(r);
    const sb = new SchemaBuilder(tr);
    pass = analyzeEvents(ws, r, tr, sb, rules);
    const names = new Set([...callNames, ...pass.wrapperNames]);
    round++;
    if (names.size === callNames.size || round >= 5) break;
    callNames = names;
  }
  const { sb, tr } = pass;

  const handlers = src.exists(HANDLER_FILE) ? parseGenerateHandler(src.read(HANDLER_FILE)) : null;
  const invByLoc = new Map(inventory.map((c) => [`${c.file}:${c.line}`, c]));
  const invByName = new Map<string, InventoryCommand[]>();
  for (const c of inventory) invByName.set(`${c.file}|${c.name}`, [...(invByName.get(`${c.file}|${c.name}`) ?? []), c]);

  const commands: Extraction['commands'] = [];
  for (const fn of allFns(sb.allScopes())) {
    // src-tauri/tests/ 中的 #[tauri::command] 是集成测试自建的测试命令，不进应用 invoke_handler。
    if (fn.loc.file.startsWith('tests/')) continue;
    const c = extractCommand(fn, tr, sb);
    if (!c) continue;
    const inv = invByLoc.get(`${fn.loc.file}:${c.attrLine}`) ?? invByName.get(`${fn.loc.file}|${fn.name}`)?.[0];
    commands.push({
      ...c,
      lane: inv?.lane ?? laneOfCommand(rules, fn.loc.file, fn.name),
      frontend: inv?.frontend ?? 'none',
      inInventory: !!inv,
      registered: handlers ? handlers.has(fn.name) : null,
    });
  }
  commands.sort((a, b) => a.lane.localeCompare(b.lane) || a.name.localeCompare(b.name) || a.fn.loc.file.localeCompare(b.fn.loc.file) || a.fn.loc.line - b.fn.loc.line);

  const inactiveCommands = ws!.inactive
    .filter((i) => i.kind === 'function_item' && i.attrs.some((a) => a.meta?.path === 'tauri::command'))
    .map((i) => ({ file: i.file, line: i.line, name: i.name, lane: laneOfCommand(rules, i.file, i.name) }));

  return { ws: ws!, sb, commands, events: pass.events, skippedEmits: pass.skipped, inventory, inactiveCommands, rules, hostNative: loadHostNative(src) };
}

function analyzeEvents(ws: Workspace, r: Resolver, tr: TypeResolver, sb: SchemaBuilder, rules: LaneRules) {
  const ea = new EventAnalyzer(r, tr);
  const events: EventOut[] = [];
  const skipped: SkippedEmit[] = [];
  const wrappers = new Map<FnDef, Wrapper[]>();
  const fns = ea.allFunctions();
  const laneOf = (fn: FnDef): string => {
    const isCmd = fn.attrs.some((a) => a.meta?.path === 'tauri::command');
    return isCmd || rules.nameRouted.has(fn.loc.file) ? laneOfCommand(rules, fn.loc.file, fn.name) : laneOfFile(rules, fn.loc.file) ?? 'UNASSIGNED';
  };
  const pushEvent = (rec: EmitRecord, fn: FnDef, payload: PayloadRes): void => {
    const owner: Owner = { refs: new Set(), unresolved: [], file: rec.file, line: rec.line };
    const schema = sb.withOwner(owner, () => {
      if (payload.k === 'sem') return sb.schema(payload.sem, 'ser');
      if (payload.k === 'json') return jsonLitSchema(payload.lit, payload.fn, ea, sb, payload.pos);
      if (payload.k === 'param') return sb.unres(`payload is parameter #${payload.idx} of wrapper ${fnLabel(fn)} (no typed call site)`);
      return sb.unres(payload.why);
    });
    events.push({ record: rec, lane: laneOf(rec.fn), owner, payload: schema });
  };

  // 第一层：直接的 tauri emit
  for (const fn of fns) {
    for (const site of fn.emits) {
      const a = ea.siteArgs(site);
      if (!a) continue;
      const recv = ea.isTauriReceiver(site, fn);
      if (recv === false) continue;
      const method = site.method === 'emit' || site.method === 'emit_to' || site.method === 'emit_filter' ? site.method : 'other';
      const name = ea.evalName(a.name, fn, site.pos);
      const payload: PayloadRes = site.method.startsWith('emit_str')
        ? { k: 'unknown', why: `${site.method}: payload is a pre-serialized JSON string` }
        : ea.evalPayload(a.payload!, fn, site.pos);
      if (name.k === 'param') {
        if (recv === null) { skipped.push({ file: fn.loc.file, line: site.line, fn: fn.name, reason: `receiver \`${exprText(site.receiver)}\` type unknown and event name is a parameter (cannot tell tauri Emitter from a project method)`, lane: laneOf(fn) }); continue; }
        const w = wrappers.get(fn) ?? [];
        w.push({ fn, nameIdx: name.idx, payload, method, site: `${fn.loc.file}:${site.line}` });
        wrappers.set(fn, w);
        continue;
      }
      if (name.k === 'unknown') {
        if (recv === null) { skipped.push({ file: fn.loc.file, line: site.line, fn: fn.name, reason: `receiver \`${exprText(site.receiver)}\` type unknown and event name not static (${name.why})`, lane: laneOf(fn) }); continue; }
        skipped.push({ file: fn.loc.file, line: site.line, fn: fn.name, reason: `tauri emit with unresolved event name: ${name.why}`, lane: laneOf(fn) });
        continue;
      }
      for (const n of name.k === 'names' ? name.names : [name]) pushEvent({ name: n.name, dynamic: n.k === 'tpl', payload, fn, file: fn.loc.file, line: site.line, method, ...(recv === null ? { receiverNote: `receiver \`${exprText(site.receiver)}\` type not inferred; accepted because the event name is static` } : {}) }, fn, payload);
    }
  }

  // 包装函数：在调用点求名字/payload；调用者若把自己的参数当名字传下去，则成为新的包装函数
  const allNames = new Set<string>();
  for (const w of wrappers.keys()) allNames.add(w.name);
  const methodNameCount = new Map<string, number>();
  for (const f of fns) methodNameCount.set(f.name, (methodNameCount.get(f.name) ?? 0) + 1);
  const resolveCallee = (call: FnDef['calls'][number], caller: FnDef): FnDef | null => {
    const ctx = ea.ctxOf(caller);
    const c = call.callee;
    if (c.k === 'path') {
      const segs = c.segs;
      if (segs.length === 2 && segs[0] === 'Self' && ctx.self) return ea.methodOf(ctx.self, segs[1]!);
      const res = r.resolvePathRes(segs, ctx.scope, 'value');
      if (res.length === 1 && res[0]!.k === 'def' && res[0]!.def.kind === 'fn') return res[0]!.def;
      if (segs.length >= 2) {
        const tyRes = r.resolvePathRes(segs.slice(0, -1), ctx.scope, 'type');
        if (tyRes.length === 1 && tyRes[0]!.k === 'def' && (tyRes[0]!.def.kind === 'struct' || tyRes[0]!.def.kind === 'enum')) return ea.methodOf({ k: 'def', def: tyRes[0]!.def, args: [] }, segs[segs.length - 1]!);
      }
      return null;
    }
    if (c.k === 'field') {
      const recv = ea.inferType(c.recv, caller, call.pos);
      if (recv) {
        let base = recv;
        while (base.k === 'ext' && ['std::Arc', 'std::Rc', 'std::Box', 'tauri::State'].includes(base.key) && base.args[0]) base = base.args[0];
        return ea.methodOf(base, c.name);
      }
      // 接收者类型推断不出：工作区内只有一个同名函数/方法时才认定
      if (methodNameCount.get(c.name) === 1) return fns.find((f) => f.name === c.name) ?? null;
    }
    return null;
  };
  const wrapperNames = new Set(allNames);
  let frontier = new Map(wrappers);
  for (let depth = 0; depth < 6 && frontier.size; depth++) {
    const next = new Map<FnDef, Wrapper[]>();
    for (const caller of fns) {
      for (const call of caller.calls) {
        const target = resolveCallee(call, caller);
        if (!target) continue;
        const ws2 = frontier.get(target);
        if (!ws2) continue;
        for (const w of ws2) {
          const nameArg = call.args[w.nameIdx];
          if (!nameArg) continue;
          const name = ea.evalName(nameArg, caller, call.pos);
          let payload = w.payload;
          if (payload.k === 'param') {
            const pa = call.args[payload.idx];
            payload = pa ? ea.evalPayload(pa, caller, call.pos) : { k: 'unknown', why: 'missing payload argument at call site' };
          }
          const via = `${w.fn.name} (${w.site})`;
          if (name.k === 'param') {
            const l = next.get(caller) ?? [];
            l.push({ fn: caller, nameIdx: name.idx, payload, method: 'other', site: w.site });
            next.set(caller, l);
            wrapperNames.add(caller.name);
            continue;
          }
          if (name.k === 'unknown') { skipped.push({ file: caller.loc.file, line: call.line, fn: caller.name, reason: `call to emit wrapper ${via}: ${name.why}`, lane: laneOf(caller) }); continue; }
          for (const n of name.k === 'names' ? name.names : [name]) pushEvent({ name: n.name, dynamic: n.k === 'tpl', payload, fn: caller, file: caller.loc.file, line: call.line, method: 'other', via }, caller, payload);
        }
      }
    }
    frontier = next;
  }
  // 没有任何调用点的包装函数：名字未知
  for (const [fn, ws2] of wrappers) {
    if (!fns.some((c) => c.calls.some((call) => resolveCallee(call, c) === fn))) {
      for (const w of ws2) skipped.push({ file: fn.loc.file, line: Number(w.site.split(':').pop()), fn: fn.name, reason: `event name is parameter #${w.nameIdx} of ${fn.name}; no resolvable call site recorded`, lane: laneOf(fn) });
    }
  }
  return { events, skipped, wrapperNames, sb, tr };
}

export function closureOf(sb: SchemaBuilder, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    const inst = sb.instances.get(k);
    if (inst) for (const c of inst.refs) stack.push(c);
  }
  return seen;
}

export function unresolvedOf(sb: SchemaBuilder, owner: Owner): { direct: UnresItem[]; viaDefs: { inst: DefInstance; items: UnresItem[] }[] } {
  const viaDefs: { inst: DefInstance; items: UnresItem[] }[] = [];
  for (const k of closureOf(sb, owner.refs)) {
    const inst = sb.instances.get(k);
    if (inst?.unresolved.length) viaDefs.push({ inst, items: inst.unresolved });
  }
  return { direct: owner.unresolved, viaDefs };
}

/** 默认读 git HEAD 中已提交的源码（与 CI 干净检出一致）。 */
export async function run(repoRoot: string, src: SourceTree = new GitHeadSource(repoRoot, ['src-tauri', 'scripts/electron-migration/inventory.mjs', INVENTORY_JSON, HOST_NATIVE_JSON])): Promise<{ files: Map<string, string>; summary: string }> {
  const ex = await extract(src);
  return renderOutputs(ex, GENERATOR, REF_PREFIX);
}
