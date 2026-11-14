/**
 * review 的运行时闭包（`import type` 不计）不得触达 Node 专有依赖，才能进入
 * `host/profiles/mobile.json`。剩下的违规只允许经由外部插件门面进入：其 Node 依赖归
 * 各自负责方，解决后 `FOREIGN_BLOCKERS` 应收窄为空，再把 review 声明为 `['desktop', 'mobile']`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeSource, checkModulesClosure, findingKey } from '../../../../scripts/portability/lib/portability.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const REVIEW = 'host/plugins/review';

/** llm `api.ts` 值导出桶（log/storage/providers…）。 */
const FOREIGN_BLOCKERS = ['host/plugins/llm/api.ts'];

function productionFiles(): string[] {
  const files = [`${REVIEW}/index.ts`, `${REVIEW}/api.ts`];
  for (const dir of ['src', 'repository']) {
    for (const name of fs.readdirSync(path.join(ROOT, REVIEW, dir))) {
      if (name.endsWith('.ts')) files.push(`${REVIEW}/${dir}/${name}`);
    }
  }
  return files;
}

describe('review runtime portability', () => {
  it('review files and every non-blocker module they load are free of Node-specific runtime deps', () => {
    const own: string[] = [];
    const external = new Set<string>();
    const reachedBlockers = new Set<string>();
    for (const file of productionFiles()) {
      const analysis = analyzeSource(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
      for (const finding of analysis.findings) {
        if (!finding.typeOnly) own.push(`${file}:${finding.line} ${findingKey(finding)}`);
      }
      for (const specifier of analysis.runtimeSpecifiers) {
        if (!specifier.startsWith('.')) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        if (target.startsWith(`${REVIEW}/`)) continue;
        if (FOREIGN_BLOCKERS.includes(target)) reachedBlockers.add(target);
        else external.add(target);
      }
    }
    expect(own).toEqual([]);
    expect(checkModulesClosure(ROOT, [...external].sort())).toEqual([]);
    expect([...reachedBlockers].sort()).toEqual(FOREIGN_BLOCKERS);
  });
});
