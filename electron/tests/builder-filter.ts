/**
 * electron-builder 的文件过滤规则（`app-builder-lib/out/util/filter.js` 的 `createFilter` / `minimatchAll`）：按顺序匹配，
 * 已选中时只看排除规则、未选中时只看包含规则，即后出现的规则优先。测试用它判定某个相对路径会不会进包。
 * 另有一条写死的规则：相对 `from` 恰为 `node_modules` 的目录一律丢弃（目录被丢弃就不再进入，其下文件也不会进包）。
 */
import { createRequire } from 'node:module';

interface Pattern { negate: boolean; match(path: string): boolean }
const { Minimatch } = createRequire(import.meta.url)('minimatch') as { Minimatch: new (pattern: string, options: { dot: boolean }) => Pattern };

export function builderFilter(patterns: readonly string[]): (relative: string) => boolean {
  const parsed = patterns.map((pattern) => new Minimatch(pattern, { dot: true }));
  return (relative) => {
    if (relative === 'node_modules' || relative.startsWith('node_modules/')) return false;
    let match = false;
    for (const pattern of parsed) {
      if (match !== pattern.negate) continue;
      match = pattern.match(relative);
    }
    return match;
  };
}
