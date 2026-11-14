/**
 * 已迁到可移植写法的 vfs-index 文件不得再出现 Node 专有运行时依赖
 * （`node:*`、全局 `Buffer` / `process`）：Lance、PDF/OCR、多模态与检索共用同一份实现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { analyzeSource, findingKey } from '../../../../scripts/portability/lib/portability.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PORTABLE = [
  'src/blob-path.ts',
  'src/chat-embeddings.ts',
  'src/commands.ts',
  'src/legacy-kb-store.ts',
  'src/multimodal-service.ts',
  'src/ocr-recovery.ts',
  'src/pdf-runtime.ts',
  'src/pdf-runtime-deps.ts',
  'src/pdf-service.ts',
  'src/retrieval-service.ts',
  'src/runtime-adapter.ts',
  'src/startup-maintenance.ts',
  'src/unified-retriever.ts',
].map(file => `host/plugins/vfs-index/${file}`);

it('vfs-index 可移植文件没有 Node 专有运行时依赖', () => {
  const findings: string[] = [];
  for (const file of PORTABLE) {
    const analysis = analyzeSource(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
    for (const finding of analysis.findings) {
      if (!finding.typeOnly) findings.push(`${file}:${finding.line} ${findingKey(finding)}`);
    }
  }
  expect(findings).toEqual([]);
});
