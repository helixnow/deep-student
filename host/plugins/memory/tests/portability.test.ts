/**
 * 已迁到可移植写法的 memory 文件不得再出现 Node 专有运行时依赖（`node:*`、全局 `Buffer` / `process`）。
 * 其余文件仍在 scripts/portability/baseline.json 中，迁完后加入此清单。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { analyzeSource, findingKey } from '../../../../scripts/portability/lib/portability.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PORTABLE = [
  'index.ts',
  'src/academic-search-executor.ts',
  'src/crypto.ts',
  'src/hpias-service.ts',
  'src/insight-recall-executor.ts',
  'src/memory-tool-executor.ts',
  'src/memory-tools-curation.ts',
  'src/paper-save-executor.ts',
  'src/research-tool-runner.ts',
].map(file => `host/plugins/memory/${file}`);

it('memory 可移植文件没有 Node 专有运行时依赖', () => {
  const findings: string[] = [];
  for (const file of PORTABLE) {
    const analysis = analyzeSource(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
    for (const finding of analysis.findings) {
      if (!finding.typeOnly) findings.push(`${file}:${finding.line} ${findingKey(finding)}`);
    }
  }
  expect(findings).toEqual([]);
});
