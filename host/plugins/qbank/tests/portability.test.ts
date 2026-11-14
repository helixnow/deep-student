/**
 * 已迁到可移植写法的 qbank 文件不得再出现 Node 专有运行时依赖（`node:*`、全局 `Buffer` / `process`）。
 * 其余文件仍在 scripts/portability/baseline.json 中，迁完后加入此清单。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { analyzeSource, findingKey } from '../../../../scripts/portability/lib/portability.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PORTABLE = [
  'src/crypto.ts',
  'src/tools/qbank-tool-env.ts',
  'src/tools/qbank-tools-authoring.ts',
  'src/tools/qbank-tools-export.ts',
  'src/tools/qbank-tools-import.ts',
  // 同步文件/zip 访问已隔离到 `src/local-runtime.node.ts`。
  'src/local-runtime.ts',
  'src/plugin.ts',
  'src/csv-commands.ts',
  'src/csv-export.ts',
  'src/csv-import.ts',
  'src/generation-figures.ts',
  'src/generation-references.ts',
  'src/paper-export-bridge.ts',
  'src/question-import-legacy-vision.ts',
  'repository/export.ts',
].map(file => `host/plugins/qbank/${file}`);

it('qbank 可移植文件没有 Node 专有运行时依赖', () => {
  const findings: string[] = [];
  for (const file of PORTABLE) {
    const analysis = analyzeSource(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
    for (const finding of analysis.findings) {
      if (!finding.typeOnly) findings.push(`${file}:${finding.line} ${findingKey(finding)}`);
    }
  }
  expect(findings).toEqual([]);
});
