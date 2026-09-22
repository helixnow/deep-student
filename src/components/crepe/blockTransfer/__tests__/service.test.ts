import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { identityEditor } from '../../plugins/blockIdentity/__tests__/fixture';
import { createBlockTransferCodec, createBlockTransferService, planBlockTransfer, planBlockIdentityUpgrade,
  type BlockTransferHost, type BlockTransferResult, type BlockTransferSnapshot, type BlockTransferRequest } from '../service';

const source = '<!-- ds:block-id=one -->\n\n**原文**  \n换行\n\n<!-- ds:block-id=two -->\n\n- 子项\n';
const target = '<!-- ds:block-id=target -->\n\n# 目标\n';
let env: Awaited<ReturnType<typeof identityEditor>>;
beforeAll(async () => { env = await identityEditor(''); });
afterAll(async () => { await env.destroy(); });
const codec = () => createBlockTransferCodec(env.crepe.editor.ctx);
const result: BlockTransferResult = {
  operation_id: 'operation', source_note_id: 's', target_note_id: 't',
  source_updated_at: 's2', target_updated_at: 't2', source_version_id: 'sv2', target_version_id: 'tv2', undone: false,
};

function harness(options: { legacyTarget?: boolean; failTransfer?: boolean; failFlush?: boolean; failRefresh?: boolean } = {}) {
  const events: string[] = [];
  let locked = false;
  const snapshots: Record<string, BlockTransferSnapshot> = {
    s: { noteId: 's', content: source, updatedAt: 's1' },
    t: { noteId: 't', content: options.legacyTarget ? '# 原目标\n' : target, updatedAt: 't1' },
  };
  const host: BlockTransferHost = {
    listNotes: async () => [{ id: 's', title: '同名', path: '/A/同名' }, { id: 't', title: '同名', path: '/B/同名' }],
    async withLockedNotes(_ids, task) { expect(locked).toBe(false); locked = true; events.push('lock'); try { return await task(); } finally { locked = false; events.push('unlock'); } },
    async flushPendingSaves() { expect(locked).toBe(true); events.push('flush'); if (options.failFlush) throw new Error('unsaved draft'); },
    async readNote(id) { expect(locked).toBe(true); events.push(`read:${id}`); return { ...snapshots[id] }; },
    invalidateNotes(ids) { expect(locked).toBe(true); events.push(`invalidate:${ids.join(',')}`); },
    async refreshNotes(ids) { expect(locked).toBe(true); events.push(`refresh:${ids.join(',')}`); if (options.failRefresh) throw new Error('refresh'); },
  };
  const call = vi.fn(async (command: string, args: Record<string, unknown>): Promise<unknown> => {
    expect(locked).toBe(true); events.push(command);
    if (command === 'notes_get_format') {
      const stable = snapshots[String(args.noteId)].content.includes('ds:block-id=');
      return { content_format: stable ? 'markdown-blocks' : 'markdown-legacy', format_version: 1, serializer_version: stable ? 'blocks-v1' : 'markdown-v1' };
    }
    if (command === 'notes_migrate_blocks') {
      const note = snapshots[String(args.noteId)]; note.content = String(args.content); note.updatedAt += '-upgraded'; return {};
    }
    if (command === 'notes_transfer_blocks') {
      if (options.failTransfer) throw new Error('OCC conflict');
      const request = args.request as BlockTransferRequest;
      snapshots.s.content = request.source_content; snapshots.t.content = request.target_content;
      return result;
    }
    return { ...result, undone: true };
  });
  const service = createBlockTransferService(host, codec(), call as <T>(command: string, args: Record<string, unknown>) => Promise<T>);
  return { events, snapshots, host, call, service, options };
}

describe('cross-page block transfer', () => {
  it('splices original spans, keeps IDs/order and leaves all other bytes alone', () => {
    const plan = planBlockTransfer(source, target, ['one'], codec());
    expect(plan.sourceContent).toBe('\n\n<!-- ds:block-id=two -->\n\n- 子项\n');
    expect(plan.targetContent).toBe(target + '\n<!-- ds:block-id=one -->\n\n**原文**  \n换行\n');
    expect(() => planBlockTransfer(source, target.replace('target', 'two'), ['one'], codec())).toThrow(/collision/);
    expect(() => planBlockTransfer(source, target, ['missing'], codec())).toThrow(/no longer exists/);
  });

  it('upgrades legacy Markdown by inserting marker lines only, with reopenable IDs', async () => {
    const legacy = '# 标题\r\n\r\n* **旧拼写**\r\n\r\n> [!toggle]- 保留\r\n> 正文\r\n';
    const plan = planBlockIdentityUpgrade(legacy, codec());
    expect(plan.content.replace(/^<!-- ds:block-id=[^\r\n]+ -->\r?\n/gm, '')).toBe(legacy);
    expect(plan.blockIds).toHaveLength(3);
    const reopened = await identityEditor(plan.content);
    try {
      const actual: string[] = [];
      reopened.view.state.doc.forEach(node => { if (node.attrs.dsBlockId) actual.push(node.attrs.dsBlockId); });
      expect(actual).toEqual(plan.blockIds);
    } finally { await reopened.destroy(); }
    expect(() => planBlockIdentityUpgrade('```js unknown-metadata\nx\n```', codec())).toThrow();
  });

  it('flushes both open drafts under lock, then invokes the exact atomic request and refreshes both', async () => {
    const h = harness();
    const receipt = await h.service.move('s', 't', ['one'], 'operation');
    const request = h.call.mock.calls.find(([command]) => command === 'notes_transfer_blocks')![1].request;
    expect(request).toEqual({ operation_id: 'operation', source_note_id: 's', target_note_id: 't',
      expected_source_updated_at: 's1', expected_target_updated_at: 't1', block_ids: ['one'],
      source_content: h.snapshots.s.content, target_content: h.snapshots.t.content });
    expect(h.events.slice(0, 4)).toEqual(['lock', 'flush', 'read:s', 'read:t']);
    expect(h.events.slice(-2)).toEqual(['refresh:s,t', 'unlock']);
    expect(receipt.result).toEqual(result);
    expect(await h.service.listTargets('s')).toEqual([{ id: 't', title: '同名', path: '/B/同名' }]);
  });

  it('upgrades the legacy target using raw Markdown before moving into it', async () => {
    const h = harness({ legacyTarget: true });
    await h.service.move('s', 't', ['one'], 'operation');
    const migration = h.call.mock.calls.find(([command]) => command === 'notes_migrate_blocks')![1];
    expect(migration.noteId).toBe('t'); expect(migration.expectedUpdatedAt).toBe('t1');
    expect(String(migration.content).replace(/^<!-- ds:block-id=[^\n]+ -->\n/gm, '')).toBe('# 原目标\n');
    expect(h.events.indexOf('refresh:t')).toBeLessThan(h.events.indexOf('notes_transfer_blocks'));
    const request = h.call.mock.calls.find(([command]) => command === 'notes_transfer_blocks')![1].request as BlockTransferRequest;
    expect(request.expected_target_updated_at).toBe('t1-upgraded');
  });

  it('does not invoke or overwrite anything when draft flush fails; transfer failure retains the source', async () => {
    const flushFailure = harness({ failFlush: true });
    await expect(flushFailure.service.move('s', 't', ['one'])).rejects.toThrow('unsaved draft');
    expect(flushFailure.call).not.toHaveBeenCalled(); expect(flushFailure.snapshots.s.content).toBe(source);
    const transferFailure = harness({ failTransfer: true });
    await expect(transferFailure.service.move('s', 't', ['one'])).rejects.toThrow('OCC conflict');
    expect(transferFailure.snapshots.s.content).toBe(source); expect(transferFailure.snapshots.t.content).toBe(target);
    expect(transferFailure.events).not.toContain('refresh:s,t');
  });

  it('retries an ambiguous failure with the exact same logged request even if source has already moved', async () => {
    const h = harness({ failTransfer: true });
    await expect(h.service.move('s', 't', ['one'], 'operation')).rejects.toThrow();
    const first = h.call.mock.calls.find(([command]) => command === 'notes_transfer_blocks')![1];
    h.snapshots.s.content = ''; h.options.failTransfer = false;
    await h.service.move('s', 't', ['one'], 'operation');
    const calls = h.call.mock.calls.filter(([command]) => command === 'notes_transfer_blocks');
    expect(calls[1][1]).toEqual(first);
  });

  it('undo uses the committed OCC tokens and refreshes both; refresh failure still reports a committed move', async () => {
    const h = harness();
    const receipt = await h.service.move('s', 't', ['one'], 'operation');
    h.snapshots.s.updatedAt = 'later-user-edit';
    const undo = await h.service.undo(receipt);
    expect(h.call).toHaveBeenLastCalledWith('notes_undo_transfer', {
      operationId: 'operation', expectedSourceUpdatedAt: 's2', expectedTargetUpdatedAt: 't2',
    });
    expect(undo.result.undone).toBe(true);
    expect(h.events.slice(-2)).toEqual(['refresh:s,t', 'unlock']);
    const failedRefresh = harness({ failRefresh: true });
    const committed = await failedRefresh.service.move('s', 't', ['one'], 'operation');
    expect(committed.result).toEqual(result); expect(committed.refreshError).toBeInstanceOf(Error);
    expect(failedRefresh.events).toContain('invalidate:s,t');
  });
});
