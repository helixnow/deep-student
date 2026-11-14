// 工作区 crate 发现与 feature 合并（只读 Cargo.toml，不调用 cargo）。
// 合并规则按 Cargo feature resolver v2 的可见语义：从 app 的 `default` 出发，传播
// `dep/feat`、`dep?/feat`、`dep:name`、同包 feature 名，以及依赖声明上的 `features = [...]`
// 与 `default-features`；`workspace = true` 继承 `[workspace.dependencies]`。只跟踪工作区成员。
import path from 'node:path/posix';
import type { SourceTree } from './source.ts';
import { parseToml, type TomlTable, type TomlValue } from './toml.ts';

export interface CrateInfo {
  /** Rust 中引用的 crate 名（lib 名，`-` → `_`）。 */
  name: string;
  pkg: string;
  /** 相对 src-tauri 的目录。 */
  dir: string;
  /** 相对 src-tauri 的 crate 根文件。 */
  root: string;
  /** 依赖 key（Rust 名）→ 包名；只含 normal 与 target 依赖。 */
  deps: Map<string, string>;
  /** 外部（非工作区）依赖的 Rust 名。 */
  externDeps: Set<string>;
  features: Set<string>;
}

const tbl = (v: TomlValue | undefined): TomlTable =>
  v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const strs = (v: TomlValue | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

interface DepDecl { pkg: string; optional: boolean; features: string[]; defaultFeatures: boolean; isPath: boolean }

/** rustDir：仓库相对路径（如 `src-tauri`）。 */
export function loadWorkspace(src: SourceTree, rustDir: string): CrateInfo[] {
  const rootToml = parseToml(src.read(path.join(rustDir, 'Cargo.toml')));
  const ws = tbl(rootToml.workspace);
  const wsDeps = tbl(ws.dependencies);
  const members = ['.', ...strs(ws.members).filter((m) => m !== '.')];
  type Pkg = { pkg: string; libName: string; dir: string; toml: TomlTable; deps: Map<string, DepDecl> };
  const pkgs = new Map<string, Pkg>();
  for (const m of members) {
    const dir = path.join(rustDir, m);
    const toml = parseToml(src.read(path.join(dir, 'Cargo.toml')));
    const pkgName = String(tbl(toml.package).name);
    const libName = String(tbl(toml.lib).name ?? pkgName).replace(/-/g, '_');
    const deps = new Map<string, DepDecl>();
    const addDeps = (t: TomlTable): void => {
      for (const [key, raw] of Object.entries(t)) {
        let d: TomlTable = typeof raw === 'string' ? { version: raw } : tbl(raw);
        if (d.workspace === true) {
          const w = wsDeps[key];
          const wt: TomlTable = typeof w === 'string' ? { version: w } : tbl(w);
          d = { ...wt, ...d, features: [...strs(wt.features), ...strs(d.features)] };
        }
        deps.set(key, {
          pkg: typeof d.package === 'string' ? d.package : key,
          optional: d.optional === true,
          features: strs(d.features),
          defaultFeatures: d['default-features'] !== false && d.default_features !== false,
          isPath: typeof d.path === 'string',
        });
      }
    };
    addDeps(tbl(toml.dependencies));
    // 桌面目标的 target 依赖（Electron 迁移只关心桌面）。
    for (const [cfg, t] of Object.entries(tbl(toml.target))) {
      if (/android|ios/.test(cfg) && !/not\(/.test(cfg)) continue;
      addDeps(tbl(tbl(t).dependencies));
    }
    pkgs.set(pkgName, { pkg: pkgName, libName, dir: path.relative(rustDir, dir) || '.', toml, deps });
  }

  const enabled = new Map<string, Set<string>>();
  const activated = new Set<string>();
  const queue: [string, string][] = [];
  const activate = (pkg: string): void => {
    const p = pkgs.get(pkg);
    if (!p || activated.has(pkg)) return;
    activated.add(pkg);
    for (const d of p.deps.values()) {
      if (d.optional || !pkgs.has(d.pkg)) continue;
      activate(d.pkg);
      if (d.defaultFeatures) queue.push([d.pkg, 'default']);
      for (const f of d.features) queue.push([d.pkg, f]);
    }
  };
  const app = [...pkgs.values()].find((p) => p.dir === '.')!;
  activate(app.pkg);
  queue.push([app.pkg, 'default']);
  while (queue.length) {
    const [pkg, feat] = queue.shift()!;
    const p = pkgs.get(pkg);
    if (!p) continue;
    const set = enabled.get(pkg) ?? new Set<string>();
    enabled.set(pkg, set);
    if (set.has(feat)) continue;
    const feats = tbl(p.toml.features);
    const optDep = p.deps.get(feat);
    if (!(feat in feats) && !optDep) continue;
    set.add(feat);
    const enableDep = (key: string): void => {
      const d = p.deps.get(key);
      if (!d || !pkgs.has(d.pkg)) return;
      activate(d.pkg);
      if (d.defaultFeatures) queue.push([d.pkg, 'default']);
      for (const f of d.features) queue.push([d.pkg, f]);
    };
    if (!(feat in feats) && optDep) { enableDep(feat); continue; }
    for (const e of strs(feats[feat])) {
      if (e.startsWith('dep:')) { enableDep(e.slice(4)); continue; }
      const slash = e.indexOf('/');
      if (slash < 0) { queue.push([pkg, e]); continue; }
      const weak = e[slash - 1] === '?';
      const depKey = e.slice(0, weak ? slash - 1 : slash);
      const depFeat = e.slice(slash + 1);
      const d = p.deps.get(depKey);
      if (!d) continue;
      if (!weak) enableDep(depKey);
      if (!weak || !d.optional || activated.has(d.pkg)) queue.push([d.pkg, depFeat]);
    }
  }

  const out: CrateInfo[] = [];
  for (const p of pkgs.values()) {
    const deps = new Map<string, string>();
    const externDeps = new Set<string>();
    for (const [key, d] of p.deps) {
      const rustName = key.replace(/-/g, '_');
      if (pkgs.has(d.pkg)) deps.set(rustName, d.pkg);
      else externDeps.add(rustName);
    }
    out.push({
      name: p.libName,
      pkg: p.pkg,
      dir: p.dir,
      root: (p.dir === '.' ? '' : p.dir + '/') + 'src/lib.rs',
      deps,
      externDeps,
      features: enabled.get(p.pkg) ?? new Set(),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
