// @vitest-environment node
/**
 * `tsconfig.node.json` 检查在 Node 里运行的构建配置：`vite.config.ts` 以及它引用的构建期官方插件表
 * （`src/platform/official-plugins.ts` → `src/ui-kernel/meta.ts` → `host/kernel/platforms.ts`）。
 * `tsc -p tsconfig.node.json` 等价于这里的编译。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runNodeConfigTypecheck } from '../../ui-kernel/__tests__/typecheck-helper';

const root = path.resolve(__dirname, '../../..');

describe('tsconfig.node.json', () => {
  it('type-checks vite.config.ts and the build-time modules it imports with zero errors, without emitting', async () => {
    const { noEmit, files, errors } = await runNodeConfigTypecheck(path.join(root, 'tsconfig.node.json'));
    // Emitting would put .js next to the sources it reaches (src/ui-kernel/meta.js …), which Vite resolves before .ts.
    expect(noEmit).toBe(true);
    expect(files).toEqual(expect.arrayContaining(['vite.config.ts', 'src/platform/official-plugins.ts', 'src/ui-kernel/meta.ts', 'host/kernel/platforms.ts']));
    expect(errors).toEqual([]);
  }, 300_000);
});
