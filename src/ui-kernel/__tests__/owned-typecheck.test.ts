// @vitest-environment node
/**
 * 内核与 SDK 源文件（含 typetests、bootstrap 与它引用的业务模块类型）按项目 tsconfig 零错误。
 * 全量 `npm run typecheck` 需排队数分钟；这里只编译负责目录的引用图，作为本地测试的快速门槛。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TYPE_CONTRACT_TIMEOUT_MS } from './typecheck-budget';
import { runOwnedTypecheck } from './typecheck-helper';

const root = path.resolve(__dirname, '../../..');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [full] : [];
  });
}

describe('ui-kernel and ui-sdk typecheck', () => {
  it('compiles every owned source file without errors under the project tsconfig', async () => {
    const rootNames = [...sources(path.join(root, 'src/ui-kernel')), ...sources(path.join(root, 'src/ui-sdk'))];
    expect(rootNames.some((f) => f.endsWith('bootstrap.ts'))).toBe(true);
    const errors = await runOwnedTypecheck(rootNames);
    expect(errors).toEqual([]);
  }, TYPE_CONTRACT_TIMEOUT_MS);
});
