// `#[cfg(...)]` 求值：迁移目标是桌面版，因此在 {macos, windows, linux} × {debug, release}
// 六个环境下求值；`test` 恒为 false（只看产品代码），`desktop` 为 true、`mobile` 为 false
// （tauri-build 的 cfg 别名）。不认识的谓词为 unknown，按三值逻辑传播。
import { parseMetaList, metaStr, type Meta, type Tok } from './attrs.ts';

export type Platform = 'macos' | 'windows' | 'linux';
export interface CfgEnv { platform: Platform; debug: boolean; features: ReadonlySet<string> }
type Tri = boolean | null;

export const PLATFORMS: readonly Platform[] = ['macos', 'windows', 'linux'];

function evalMeta(m: Meta | null, env: CfgEnv): Tri {
  if (!m) return null;
  if (m.kind === 'path') {
    switch (m.path) {
      case 'test': return false;
      case 'unix': return env.platform !== 'windows';
      case 'windows': return env.platform === 'windows';
      case 'debug_assertions': return env.debug;
      case 'desktop': return true;
      case 'mobile': return false;
      case 'doc': case 'docsrs': case 'miri': case 'coverage': case 'fuzzing': return false;
      default: return null;
    }
  }
  if (m.kind === 'nv') {
    const v = metaStr(m);
    if (v === null) return null;
    switch (m.path) {
      case 'feature': return env.features.has(v);
      case 'target_os': return v === env.platform;
      case 'target_family': return v === (env.platform === 'windows' ? 'windows' : 'unix');
      case 'target_vendor': return env.platform === 'macos' ? v === 'apple' : null;
      default: return null;
    }
  }
  const items = parseMetaList(m.toks).map((x) => evalMeta(x, env));
  switch (m.path) {
    case 'not': return items.length === 1 ? (items[0] === null ? null : !items[0]) : null;
    case 'all': return items.some((x) => x === false) ? false : items.some((x) => x === null) ? null : true;
    case 'any': return items.some((x) => x === true) ? true : items.some((x) => x === null) ? null : false;
    default: return null;
  }
}

export interface CfgVerdict {
  /** 在至少一个桌面环境下可能启用（true 或 unknown）。 */
  active: boolean;
  /** 所有桌面环境都确定启用。 */
  always: boolean;
  /** 启用的平台（unknown 也计入）。 */
  platforms: Platform[];
}

export function evalCfg(predToks: Tok[], features: ReadonlySet<string>): CfgVerdict {
  const metas = parseMetaList(predToks);
  const pred = metas.length === 1 ? metas[0]! : null;
  const platforms = new Set<Platform>();
  let always = true;
  let active = false;
  for (const platform of PLATFORMS) {
    for (const debug of [true, false]) {
      const r = evalMeta(pred, { platform, debug, features });
      if (r !== false) { active = true; platforms.add(platform); }
      if (r !== true) always = false;
    }
  }
  return { active, always, platforms: PLATFORMS.filter((p) => platforms.has(p)) };
}
