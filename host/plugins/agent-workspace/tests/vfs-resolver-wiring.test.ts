import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { memorySettings } from './support.ts';
import { inMemoryVfsDb } from './vfs-support.ts';
import type { AgentVfsResolver } from '../api.ts';

it('publishes the resolver from index when VFS, repository and docs providers arrive', async () => {
  const db = inMemoryVfsDb();
  const getContent = vi.fn(() => 'aGVsbG8=');
  const parse = vi.fn(async () => '<hello>');
  const host = await createTestHost({ provide: {
    settings: memorySettings(),
    storage: { locations: { activeDir: '.' }, database: () => db.executor },
    vfs: { version: 1, database: { getConnSafe: () => db.executor, blobsDir: () => '.' } },
    vfsRepo: { files: { getContent }, blobs: {} },
  } });
  try {
    await host.install(plugin);
    const resolver = host.ctx.get('agentVfsResolver') as AgentVfsResolver;
    const ref = { type: 'file' as const, sourceId: 'file-1', resourceHash: 'hash', name: 'readme.txt' };
    await expect(resolver.resolveVfsRefToBlocks(ref, false)).rejects.toThrow('requires vfs');
    const { definePlugin } = await import('../../../kernel/api.ts');
    await host.install(definePlugin({
      meta: { id: 'test.docs', commands: [], provides: ['docs'] },
      apply(ctx) { ctx.provide('docs', { extractTextFromBase64: parse }); },
    }));
    expect(await resolver.resolveVfsRefToBlocks(ref, false)).toEqual([
      { type: 'text', text: '<file name="readme.txt">&lt;hello&gt;</file>' },
    ]);
    expect(getContent).toHaveBeenCalledWith(db.executor, '.', 'file-1');
    expect(parse).toHaveBeenCalledWith('readme.txt', 'aGVsbG8=');
    const content = await resolver.resolveContextRefDataToContent({ refs: [ref] }, false);
    expect(content.textContents).toEqual([
      '<injected_context>\n[readme.txt]\n<file name="readme.txt">&lt;hello&gt;</file>\n</injected_context>',
    ]);
    await host.unload('test.docs');
    await expect(resolver.resolveVfsRefToBlocks(ref, false)).rejects.toThrow('requires vfs');
  } finally {
    await host.dispose();
    db.close();
  }
});
