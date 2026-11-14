// 工作区加载：按 crate 根沿 `mod` 声明遍历文件（遵循 Rust reference 的 mod-rs / non-mod-rs
// 路径规则与 `#[path]`），逐文件解析为作用域树。源码来自 SourceTree（默认 git HEAD）。
import path from 'node:path/posix';
import type { Parser } from 'web-tree-sitter';
import { loadWorkspace, type CrateInfo } from './cargo.ts';
import { collectItems, exprOf, newScope, setExprParser, type FileCtx } from './collect.ts';
import type { Attr, Scope } from './model.ts';
import type { SourceTree } from './source.ts';

export interface InactiveItem { file: string; line: number; kind: string; name: string; attrs: Attr[] }

export interface Workspace {
  /** 仓库相对的 Rust 根（`src-tauri`）。所有 `file` 字段相对它。 */
  rustDir: string;
  crates: Map<string, CrateInfo & { scope: Scope }>;
  files: Map<string, { crate: string; scope: Scope }>;
  /** 含 `#[tauri::command]` 文本但未被任何 crate 的模块树引用的文件。 */
  orphanFiles: string[];
  inactive: InactiveItem[];
  parseErrors: { file: string; line: number }[];
}

const SKIP = /(^|\/)(target|vendor|gen|\.[^/]*)\//;

export interface LoadOptions { callNames?: ReadonlySet<string> | null; includeTests?: boolean }

export function loadRust(parser: Parser, src: SourceTree, rustDir: string, opts: LoadOptions = {}): Workspace {
  const crateInfos = loadWorkspace(src, rustDir);
  const ws: Workspace = { rustDir, crates: new Map(), files: new Map(), orphanFiles: [], inactive: [], parseErrors: [] };
  const full = (rel: string): string => path.join(rustDir, rel);
  const rsUnder = (dir: string): string[] => src.list(full(dir) + '/').filter((f) => f.endsWith('.rs') && !SKIP.test(path.relative(rustDir, f))).map((f) => path.relative(rustDir, f));
  if ('prefetch' in src && typeof (src as { prefetch?: unknown }).prefetch === 'function') {
    (src as unknown as { prefetch(p: string[]): void }).prefetch([...rsUnder('src'), ...rsUnder('crates'), ...rsUnder('tests')].map(full));
  }

  const loadFile = (file: string, crate: CrateInfo, scope: Scope, modRs: boolean): void => {
    file = path.normalize(file);
    if (ws.files.has(file) || !src.exists(full(file))) return;
    const text = src.read(full(file));
    ws.files.set(file, { crate: crate.name, scope });
    const tree = parser.parse(text);
    if (!tree) throw new Error(`tree-sitter 解析失败：${file}`);
    try {
      for (const e of tree.rootNode.descendantsOfType('ERROR')) if (e) ws.parseErrors.push({ file, line: e.startPosition.row + 1 });
      const baseDir = modRs ? path.dirname(file) : path.join(path.dirname(file), path.basename(file, '.rs'));
      const ctx: FileCtx = {
        file, crate: crate.name, features: crate.features, callNames: opts.callNames ?? null,
        onModDecl: (name, pathAttr, parent, inlineDirs) => {
          const child = newScope(`${parent.id}::${name}`, crate.name, [...parent.path, name], '', parent, null);
          let target: string;
          let childModRs: boolean;
          if (pathAttr) {
            const dir = inlineDirs.length ? path.join(baseDir, ...inlineDirs) : path.dirname(file);
            target = path.join(dir, pathAttr);
            childModRs = true;
          } else {
            const dir = path.join(baseDir, ...inlineDirs);
            const a = path.join(dir, `${name}.rs`);
            const b = path.join(dir, name, 'mod.rs');
            target = src.exists(full(a)) ? a : b;
            childModRs = target === b;
          }
          child.file = target;
          parent.defs.set(name, [...(parent.defs.get(name) ?? []), { kind: 'mod', name, scope: child, vis: true, id: child.id, loc: { file, line: 0 } }]);
          loadFile(target, crate, child, childModRs);
        },
        onInactive: (kind, name, line, attrs) => ws.inactive.push({ file, line, kind, name, attrs }),
      };
      collectItems(tree.rootNode, scope, ctx, [], null, null);
    } finally {
      tree.delete();
    }
  };

  setExprParser((text) => {
    const t = parser.parse(`fn __json_value() { ${text} }`);
    if (!t) return { k: 'other', text, line: 0 };
    try {
      const body = t.rootNode.namedChildren[0]?.childForFieldName('body');
      const e = body?.namedChildren.filter((c) => c && !c.type.endsWith('comment'));
      return e && e.length === 1 && !t.rootNode.hasError ? exprOf(e[0]!) : { k: 'other', text, line: 0 };
    } finally { t.delete(); }
  });
  const roots: CrateInfo[] = [...crateInfos];
  if (opts.includeTests !== false) {
    const app = crateInfos.find((c) => c.dir === '.');
    if (app) {
      for (const f of rsUnder('tests')) {
        if (path.dirname(f) !== 'tests') continue; // tests/<name>/ 子目录是被引用的模块
        const name = `test_${path.basename(f, '.rs')}`;
        roots.push({ ...app, name, pkg: name, dir: 'tests', root: f, deps: new Map([...app.deps, [app.name, app.pkg]]) });
      }
    }
  }
  for (const c of roots) {
    const scope = newScope(c.name, c.name, [], c.root, null, null);
    ws.crates.set(c.name, { ...c, scope });
    loadFile(c.root, c, scope, true);
  }
  for (const f of [...rsUnder('src'), ...rsUnder('crates')]) {
    if (!ws.files.has(f) && /#\[tauri::command/.test(src.read(full(f)))) ws.orphanFiles.push(f);
  }
  ws.orphanFiles.sort();
  return ws;
}
