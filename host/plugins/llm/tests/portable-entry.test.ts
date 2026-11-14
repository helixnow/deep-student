/**
 * llm 可移植入口：chat-pipeline / review / qbank / anki / media 等插件值导入 `llm/api.ts`
 * （以及它依赖的 `llm-providers/api.ts`），运行时闭包里 llm 与 llm-providers 自己的文件
 * 不得加载 Node 专有模块（`import type` 不计），判定用 `scripts/portability` 扫描器。
 *
 * 闭包里剩余的 Node 依赖只允许经由 PENDING_EDGES 进入：截断这些边后闭包必须为空。登记的边被修掉后
 * 测试会要求从这里删除；清空后两个入口即可进移动端 profile。
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ENTRIES = ['host/plugins/llm/api.ts', 'host/plugins/llm-providers/api.ts'];

/** importer → 非可移植模块。 */
const PENDING_EDGES: readonly (readonly [string, string])[] = [];
const PENDING_TARGETS = [...new Set(PENDING_EDGES.map(([, to]) => to))];
const key = (v: { file: string; key: string; line: number }) => `${v.file}:${v.key}:${v.line}`;

/** importer 中指向 target 的值导入（`import type` 不算）。 */
function valueImports(importer: string, target: string): boolean {
  const text = readFileSync(join(ROOT, importer), 'utf8');
  return [...text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)]
    .some((match) => relative(ROOT, join(ROOT, importer, '..', match[1]!)).split('\\').join('/') === target);
}

describe('llm portable entry', () => {
  it('no llm or llm-providers file in the api.ts runtime closure loads Node modules', () => {
    const own = checkModulesClosure(ROOT, ENTRIES)
      .filter(violation => /^host\/plugins\/llm(-providers)?\//.test(violation.file));
    expect(own).toEqual([]);
  });

  it('remaining Node dependencies arrive only through the pending targets', () => {
    const pending = new Set(checkModulesClosure(ROOT, PENDING_TARGETS).map(key));
    expect(checkModulesClosure(ROOT, ENTRIES).filter(v => !pending.has(key(v)))).toEqual([]);
  });

  it.each(PENDING_EDGES)('%s -> %s is still a value import of a non-portable module', (from, to) => {
    expect(valueImports(from, to), `${from} no longer imports ${to}; remove the edge`).toBe(true);
    expect(checkModulesClosure(ROOT, [to]), `${to} is portable now; remove its edges`).not.toEqual([]);
  });
});
