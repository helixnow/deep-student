// `#[tauri::command]` 抽取：参数键名、注入参数、返回值与错误类型。
//
// 依据 tauri-macros-2.6.3 src/command/wrapper.rs：
// - 属性参数 `rename_all = "snake_case" | "camelCase"`（默认 camelCase）、`rename = "..."`（对外命令名）、
//   `root`、`async`；`async fn` 或 `async` 标志 → 异步执行；
// - `parse_arg`：键名取 `Pat::Ident`（去 `r#`）、`_` → ""、`Pat::Struct`/`Pat::TupleStruct` → 类型路径最后一段，
//   再按 heck 转换；
// tauri-2.11.5：
// - `CommandArg` 的特殊实现：AppHandle（app.rs）、State（state.rs）、WebviewWindow、Webview、Window、
//   ipc::Channel（channel.rs，按 key 读取 `__CHANNEL__:<id>` 字符串）、ipc::Request（mod.rs）、
//   ipc::CommandScope / GlobalScope（authority.rs）；其余类型走 `impl<D: Deserialize> CommandArg for D`；
// - ipc/command.rs `CommandItem::deserialize_option`：键缺失 → visit_none，因此只有 Option<T> 参数可省略；
// - ipc/mod.rs：成功值 `serde_json::to_string`；`impl<T: Serialize> From<T> for InvokeError` 用
//   `serde_json::to_value`；`From<tauri::Error>` → `Value::String(error.to_string())`；
//   `tauri::ipc::Response` 原样返回 `InvokeResponseBody`（Raw 字节 → 前端 ArrayBuffer）。
import { parseMetaList, metaStr } from './attrs.ts';
import { heckLowerCamel, heckSnake } from './case.ts';
import type { FnDef, Scope } from './model.ts';
import { rtypeText, semText, type SchemaBuilder, type Sem, type TypeResolver, type Owner } from './schema.ts';
import type { JsonSchema, InjectedArg } from '../../../../host/kernel/contract.ts';

export interface CommandArgOut { key: string; rustName: string; schema: JsonSchema; optional: boolean }

export interface CommandOut {
  name: string;
  fn: FnDef;
  attrLine: number;
  async: boolean;
  renameAll?: 'snake_case' | 'camelCase';
  args: CommandArgOut[];
  injected: (InjectedArg & { key?: string; rustName?: string })[];
  result: JsonSchema;
  error?: JsonSchema;
  owner: Owner;
}

export function isCommandAttr(path: string): boolean {
  return path === 'tauri::command' || path === '::tauri::command';
}

export function allFns(scopes: Scope[]): FnDef[] {
  const out: FnDef[] = [];
  for (const s of scopes) for (const ds of s.defs.values()) for (const d of ds) if (d.kind === 'fn') out.push(d);
  return out;
}

const TAURI_INJECTED: Record<string, InjectedArg['kind'] | 'scope'> = {
  State: 'state', AppHandle: 'app-handle', Window: 'window', WebviewWindow: 'webview-window', Webview: 'webview',
  Channel: 'channel', Request: 'request', CommandScope: 'scope', GlobalScope: 'scope',
};

export function extractCommand(fn: FnDef, tr: TypeResolver, sb: SchemaBuilder): CommandOut | null {
  const attr = fn.attrs.find((a) => a.meta && isCommandAttr(a.meta.path));
  if (!attr || !attr.meta) return null;
  let renameAll: 'snake_case' | 'camelCase' | undefined;
  let rename: string | null = null;
  let asyncFlag = false;
  if (attr.meta.kind === 'list') {
    for (const m of parseMetaList(attr.meta.toks)) {
      if (!m) continue;
      if (m.kind === 'nv' && m.path === 'rename_all') renameAll = metaStr(m) as 'snake_case' | 'camelCase';
      else if (m.kind === 'nv' && m.path === 'rename') rename = metaStr(m);
      else if (m.kind === 'path' && m.path === 'async') asyncFlag = true;
    }
  }
  const owner: Owner = { refs: new Set(), unresolved: [], file: fn.loc.file, line: fn.loc.line };
  const ctx = { scope: fn.scope, env: new Map<string, Sem>(), self: null };
  for (const g of fn.generics) ctx.env.set(g, { k: 'generic', name: g });
  const out: CommandOut = {
    name: rename ?? fn.name, fn, attrLine: attr.line, async: fn.async || asyncFlag, ...(renameAll ? { renameAll } : {}),
    args: [], injected: [], result: {}, owner,
  };
  sb.withOwner(owner, () => {
    for (const p of fn.params) {
      owner.line = p.line;
      const sem = tr.sem(p.ty, ctx);
      const tauriTy = sem.k === 'ext' && sem.path.startsWith('tauri::') ? sem.path.split('::').pop()! : null;
      const kind = tauriTy ? TAURI_INJECTED[tauriTy] : undefined;
      const rawName = p.name ?? '';
      const key = renameAll === 'snake_case' ? heckSnake(rawName) : heckLowerCamel(rawName);
      if (kind) {
        if (kind === 'state') out.injected.push({ kind: 'state', rustType: sem.k === 'ext' && sem.args[0] ? semText(sem.args[0]) : rtypeText(p.ty) });
        else if (kind === 'channel') {
          const payload = sem.k === 'ext' && sem.args[0] ? sb.schema(sem.args[0], 'ser') : { 'x-rust': 'serde_json::Value' };
          out.injected.push({ kind: 'channel', schema: payload, key, rustName: rawName });
          // Channel 由前端按 key 传入 `__CHANNEL__:<id>` 字符串（tauri ipc/channel.rs），参数校验需要它。
          out.args.push({ key, rustName: rawName, schema: { type: 'string', pattern: '^__CHANNEL__:[0-9]+$', 'x-channel': payload }, optional: false });
        } else if (kind === 'scope') out.injected.push({ kind: 'other', rustType: rtypeText(p.ty) });
        else out.injected.push({ kind } as InjectedArg);
        continue;
      }
      if (sem.k === 'ext' && sem.path.startsWith('tauri::')) {
        out.args.push({ key, rustName: rawName, schema: sb.unres(`tauri type \`${sem.path}\` as command argument`), optional: false });
        continue;
      }
      if (p.name === null) {
        out.args.push({ key: '', rustName: p.pattern, schema: sb.unres(`unsupported parameter pattern \`${p.pattern}\``), optional: false });
        continue;
      }
      const optional = sem.k === 'ext' && sem.key === 'std::Option';
      out.args.push({ key, rustName: rawName, schema: sb.schema(sem, 'de'), optional });
    }
    owner.line = fn.loc.line;
    const ret: Sem = fn.ret ? tr.sem(fn.ret, ctx) : { k: 'unit' };
    let okSem: Sem = ret;
    let errSem: Sem | null = null;
    if (ret.k === 'ext' && ret.key === 'std::Result') {
      okSem = ret.args[0] ?? { k: 'unres', why: 'Result without Ok type' };
      errSem = ret.args[1] ?? { k: 'unres', why: `Result alias without error type: ${fn.ret ? rtypeText(fn.ret) : ''}` };
    }
    out.result = okSem.k === 'ext' && okSem.path.startsWith('tauri::') && okSem.key === 'tauri::Response'
      ? { 'x-rust': 'tauri::ipc::Response', 'x-binary': true, description: 'InvokeResponseBody：Raw 字节时前端收到 ArrayBuffer' }
      : sb.schema(okSem, 'ser');
    if (errSem) {
      if (errSem.k === 'ext' && errSem.key === 'tauri::Error') out.error = { type: 'string', 'x-rust': 'tauri::Error', description: 'Display 文本（InvokeError From<tauri::Error>）' };
      else if (errSem.k === 'ext' && errSem.key === 'tauri::InvokeError') out.error = { 'x-rust': 'tauri::ipc::InvokeError' };
      else out.error = sb.schema(errSem, 'ser');
    }
  });
  return out;
}
