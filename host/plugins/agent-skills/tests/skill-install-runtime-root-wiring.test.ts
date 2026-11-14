/**
 * The production plugin resolves skill_scan / skill_install runtime roots through agent-workspace `runtimeRootById`.
 * On Windows the workspace and authorized roots are validated by native directory identity, so every caller has to
 * pass `nativeWindowsFiles` the way agent-workspace's own `deps()` does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import type { ExecutionContext, ToolResultInfo } from '../../chat/api.ts';
import type { RuntimeRootDeps } from '../../agent-workspace/api.ts';
import plugin from '../index.ts';
import { memorySettings, unavailableStorage } from './platform-stubs.ts';

const runtimeRootDeps = vi.hoisted(() => [] as RuntimeRootDeps[]);
vi.mock('../../agent-workspace/api.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../agent-workspace/api.ts')>();
  return {
    ...actual,
    runtimeRootById: (...args: Parameters<typeof actual.runtimeRootById>) => {
      runtimeRootDeps.push(args[0]);
      return actual.runtimeRootById(...args);
    },
  };
});

afterEach(() => { runtimeRootDeps.length = 0; });

describe('skill_scan runtime root wiring', () => {
  it('on Windows skill_scan resolves runtime roots with nativeWindowsFiles, which the workspace root needs to resolve as configured', async () => {
    const windowsFiles = { runtimeRootIdentity: () => { throw new Error('not called for the temp root'); } };
    const host = await createTestHost({
      plugins: [pathsPlugin, plugin],
      provide: { settings: memorySettings(), storage: unavailableStorage(), nativeWindowsFiles: windowsFiles },
    });
    try {
      const executor = host.ctx.agentTools.toolExecutors().find(candidate => candidate.canHandle('skill_scan'));
      const context = {
        session_id: 'sess-wiring', block_id: 'blk', skill_package_roots: null,
        emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined, emitToolCallError: () => undefined,
        saveToolBlock: (_result: ToolResultInfo) => undefined,
      } as unknown as ExecutionContext;
      const result = await executor!.execute!({ id: 'call-1', name: 'skill_scan',
        arguments: { source: { root_id: 'temp', path: 'missing.zip' } } }, context) as ToolResultInfo;
      expect([result.success, result.error]).toEqual([false, 'Skill package file not found at temp:missing.zip']);
      expect(runtimeRootDeps).toHaveLength(1);
      expect(runtimeRootDeps[0]!.windowsFiles).toBe(windowsFiles);
    } finally { await host.dispose(); }
  });
});
