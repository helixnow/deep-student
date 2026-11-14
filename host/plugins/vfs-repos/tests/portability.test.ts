/**
 * vfs-repos 的跨插件门面 `api.ts`（vfs、qbank、media 等从这里取值）在移动端也要能加载：
 * 运行时闭包（`import type` 不计）不得触达 Node 专有依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeSource, checkModulesClosure, findingKey } from '../../../../scripts/portability/lib/portability.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** 同步文件/worker 访问已隔离到 `src/local-runtime.node.ts`；这些文件本身不得再触达 Node。 */
const PORTABLE = [
  'api.ts',
  'src/local-runtime.ts',
  'src/plugin.ts',
  'src/maintenance-service.ts',
  'src/worker-service.ts',
  'repository/attachment-upload.ts',
  'repository/attachment-utils.ts',
  'repository/attachments.ts',
  'repository/blobs.ts',
  'repository/files.ts',
].map(file => `host/plugins/vfs-repos/${file}`);

describe('vfs-repos api.ts portability', () => {
  it('the runtime closure of host/plugins/vfs-repos/api.ts is free of Node-specific deps', () => {
    expect(checkModulesClosure(ROOT, ['host/plugins/vfs-repos/api.ts'])).toEqual([]);
  });
  it('content-hash repository closures are portable', () => {
    expect(checkModulesClosure(ROOT, [
      'host/plugins/vfs-repos/repository/resources.ts',
      'host/plugins/vfs-repos/repository/questions.ts',
      'host/plugins/vfs-repos/repository/embedding-dims.ts',
      'host/plugins/vfs-repos/repository/index-units.ts',
      'host/plugins/vfs-repos/repository/maintenance.ts',
      'host/plugins/vfs-repos/repository/path-cache.ts',
      'host/plugins/vfs-repos/repository/ocr-utils.ts',
    ])).toEqual([]);
  });
});

describe('vfs-repos 可移植文件', () => {
  it('同步本地运行时端口之外没有 Node 专有运行时依赖', () => {
    const findings: string[] = [];
    for (const file of PORTABLE) {
      const analysis = analyzeSource(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
      for (const finding of analysis.findings) {
        if (!finding.typeOnly) findings.push(`${file}:${finding.line} ${findingKey(finding)}`);
      }
    }
    expect(findings).toEqual([]);
  });
});
