// 跨 lane 引用统计：lane X 的文件中定义的条目被 lane Y 的文件引用的位置。
// 解析依据（精度优先）：
//   1. `use` 声明（含嵌套列表、别名、`pub use` 重导出链）解析到定义；导入名在该文件中的标识符出现处计为使用点；
//   2. 代码中的限定路径（`a::b::C`、`Type::method`），首段经该处可见的 use 别名 / crate / self / super 解析；
//   3. 值上的方法调用（`x.method()`）需要类型推断，不统计（召回损失，见报告）。
// 经 glob 重导出、或定义所在文件不在模块树内（按路径推断模块）的匹配标记为 uncertain。
import { inRanges } from './rust-analysis.mjs';

export function crossLaneRefs({ analyses, fileMod, index, laneOf }) {
  const refs = [];
  const globRefs = [];
  for (const a of analyses) {
    const lane = laneOf(a.rel);
    if (!lane) continue;
    const fm = fileMod.get(a.rel);
    const fileIsTest = /(^|\/)tests\//.test(a.rel) || fm.test === true;
    for (const u of a.uses) {
      const modPath = [...fm.path, ...u.inline];
      if (u.glob) {
        const r = index.resolveFrom(modPath, u.segs, 0, true);
        if (r?.module) {
          const m = index.modules.get(r.module);
          const providerFile = m ? [...m.files][0] : null;
          const providerLane = providerFile ? laneOf(providerFile) : null;
          if (providerLane && providerLane !== lane) {
            globRefs.push({ module: r.module, providerLane, lane, file: a.rel, line: u.line, test: fileIsTest || u.test });
          }
        }
        continue;
      }
      const r = index.resolveFrom(modPath, u.segs, 0, true);
      if (!r?.def) continue;
      const def = index.defs.get(r.def);
      if (!def || !def.lane || def.lane === lane) continue;
      const sites = (a.identSites[u.alias] ?? []).map((s) => ({ line: s.line, test: fileIsTest || u.test || inRanges(a.testCode, s.index) }));
      refs.push({
        def: def.id,
        providerLane: def.lane,
        lane,
        file: a.rel,
        via: 'use',
        line: u.line,
        test: fileIsTest || u.test,
        uncertain: Boolean(r.viaGlob || def.inferred),
        sites,
      });
    }
    for (const s of a.scopedRefs) {
      const r = index.resolveInFile(a, s.index, s.segs);
      if (!r?.def) continue;
      const def = index.defs.get(r.def);
      if (!def || !def.lane || def.lane === lane) continue;
      const test = fileIsTest || inRanges(a.testCode, s.index);
      refs.push({
        def: def.id,
        providerLane: def.lane,
        lane,
        file: a.rel,
        via: 'path',
        line: s.line,
        test,
        uncertain: Boolean(r.viaGlob || def.inferred),
        sites: [{ line: s.line, test }],
      });
    }
  }
  return { refs, globRefs };
}

/** 按提供方 lane 聚合：item → { def, consumers: { lane → { prod, test, files:Set, samples[] } }, uncertain } */
export function aggregate(index, refs) {
  const provides = new Map();
  for (const r of refs) {
    const per = provides.get(r.providerLane) ?? provides.set(r.providerLane, new Map()).get(r.providerLane);
    const def = index.defs.get(r.def);
    const item = per.get(r.def) ?? per.set(r.def, { def, consumers: new Map(), uncertain: false, total: 0, prod: 0 }).get(r.def);
    item.uncertain ||= r.uncertain;
    const c = item.consumers.get(r.lane) ?? item.consumers.set(r.lane, { prod: 0, test: 0, files: new Set(), samples: [] }).get(r.lane);
    const sites = r.sites.length ? r.sites : [{ line: r.line, test: r.test }];
    for (const s of sites) {
      if (s.test) c.test++;
      else c.prod++;
      if (c.samples.length < 4 && !c.samples.includes(`${r.file}:${s.line}`)) c.samples.push(`${r.file}:${s.line}`);
    }
    c.files.add(r.file);
    item.total += sites.length;
    item.prod += sites.filter((s) => !s.test).length;
  }
  return provides;
}
