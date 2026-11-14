/**
 * 已迁到可移植写法的 vfs-handlers 文件不得再出现 Node 专有运行时依赖
 * （`node:*`、全局 `Buffer` / `process`）：命令层在移动端与桌面共用同一份实现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { analyzeSource, findingKey } from '../../../../scripts/portability/lib/portability.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PORTABLE = [
  'repository/media-cache.ts',
  'repository/refs.ts',
  'src/attachments.ts',
  'src/files.ts',
  'src/filestream.ts',
  'src/media-cache.ts',
  'src/refs.ts',
  'src/vector-cache-files.ts',
].map(file => `host/plugins/vfs-handlers/${file}`);

it('vfs-handlers 可移植文件没有 Node 专有运行时依赖', () => {
  const findings: string[] = [];
  for (const file of PORTABLE) {
    const analysis = analyzeSource(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
    for (const finding of analysis.findings) {
      if (!finding.typeOnly) findings.push(`${file}:${finding.line} ${findingKey(finding)}`);
    }
  }
  expect(findings).toEqual([]);
});
