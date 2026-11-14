import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import agentPlugin from '../../agent-skills/index.ts';
import notesPlugin from '../../notes/index.ts';
import reposPlugin from '../../vfs-repos/index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import { BackendEventsSink, ChatV2Emitter } from '../../chat/api.ts';
import plugin from '../index.ts';
import type { BuiltinResourceExecutor, ResourceToolContext } from '../src/tools/resource-executor.ts';
import { ACR_BRIDGE_REQUEST, ACR_BRIDGE_RESPONSE_PREFIX } from '../../agent-skills/api.ts';

let root: string, host: TestHost, storage: ReturnType<typeof createStorageService>;
let delegationEnabled = false;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-mindmap-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const report = await storage.migrations.runAll(); expect(report.success, report.error ?? '').toBe(true);
  const settings = createSettingsService({ db: () => storage.database('mistakes'), secureStore: () => null, secrets: { isSensitiveKey: () => false } });
  host = await createTestHost({ app: { dataDir: root }, provide: { storage, settings,
    featureFlags: { load: () => ({ isFeatureEnabled: () => delegationEnabled }) },
  }, plugins: [pathsPlugin, agentPlugin, notesPlugin, reposPlugin, indexPlugin, plugin] });
}, 120_000);
afterAll(async () => { await host?.dispose(); storage?.dispose(); if (root) fs.rmSync(root, { recursive: true, force: true }); });
const db = () => host.ctx.vfsDatabase.getConnSafe();
async function execute(name: string, args: unknown, signal?: AbortSignal) {
  const executor = host.ctx.agentTools.toolExecutors().find(e => e.name() === 'BuiltinResourceExecutor') as BuiltinResourceExecutor;
  expect(executor.canHandle(name)).toBe(true);
  const emitter = new ChatV2Emitter(new BackendEventsSink(host.ctx.backendEvents), 'mindmap-tools', false);
  const saved: unknown[] = [];
  const context: ResourceToolContext = { services: host.ctx, session_id: 'mindmap-session', cancellation_token: signal ?? null,
    windowRef: () => ({ window: 'main', webview: 'main' }),
    isCancelled: () => signal?.aborted ?? false, message_id: 'm', block_id: 'b', variant_id: null, round_id: null, skill_state_version: null,
    emitter, emitToolCallStart(toolName, input, id) { emitter.emitStart('tool_call', 'm', 'b', { toolName, input, id }, null); }, saveToolBlock(result) { saved.push(result); } };
  const result = await executor.execute({ id: 'call', name, arguments: args }, context);
  expect(saved).toEqual([result]); return result;
}
it('creates fixed node aliases and valid associations before emitting created and capturing the initial version', async () => {
  host.events.length = 0;
  const result = await execute('builtin-mindmap_create', { title: '  Created map  ', content: {
    root: { id: 'root', name: 'Root alias', children: [{ id: 'child', label: 'Child alias' }] },
    associations: [{ source: ' root ', target: 'child', label: ' edge ' }, { id: 'same', source: 'root', target: 'root' },
      { id: 'assoc_g1', source: 'child', target: 'root', style: { color: 'blue' } }, { source: 'missing', target: 'root' }],
  } });
  expect(result.success).toBe(true);
  const output = result.output as { mindmap: { id: string; title: string }; versionId: string; citation: string };
  expect(output.mindmap.title).toBe('  Created map  ');
  const content = JSON.parse(host.ctx.vfsRepo.mindmaps.getMindmapContent(db(), output.mindmap.id)!);
  expect(content.root.text).toBe('Root alias'); expect(content.root.children[0].text).toBe('Child alias');
  expect(content.associations).toEqual([{ id: 'assoc_g1', source: 'root', target: 'child', label: 'edge' },
    { id: 'assoc_g2', source: 'child', target: 'root', style: { color: 'blue' } }]);
  expect(output.citation).toBe(`[思维导图:${output.versionId}:  Created map  ]`);
  expect(host.ctx.vfsRepo.mindmaps.getVersions(db(), output.mindmap.id)).toHaveLength(1);
  expect(host.eventsNamed('dstu:change')).toEqual([expect.objectContaining({ type: 'created', node: expect.objectContaining({ id: output.mindmap.id }) })]);
});
it('updates with exactly one post-update snapshot and returns sorted structural version differences', async () => {
  const initial = { root: { id: 'root', text: 'Root', children: [{ id: 'a', text: 'A', children: [{ id: 'move', text: 'Move' }] }, { id: 'b', text: 'B' }, { id: 'old', text: 'Old' }] } };
  const created = await execute('mindmap_create', { title: 'Diff map', content: initial });
  const old = created.output as { mindmap: { id: string }; versionId: string };
  // Rust versions share deduplicated resources with the live document; the
  // copy-on-write branch counts another mindmap (including deleted ones), not a version.
  const canonical = host.ctx.vfsRepo.mindmaps.getMindmapContent(db(), old.mindmap.id)!;
  host.ctx.vfsRepo.mindmaps.createMindmap(db(), { title: 'Shared baseline', content: canonical });
  const updated = await execute('mindmap_update', { mindmap_id: old.mindmap.id, content: { root: { id: 'root', text: 'Root', children: [
    { id: 'a', text: 'Changed A' }, { id: 'b', text: 'B', children: [{ id: 'move', text: 'Move' }] }, { id: 'new', text: 'New' },
  ] } } });
  expect(updated.success).toBe(true);
  const current = updated.output as { versionId: string };
  expect(current.versionId).not.toBe(old.versionId);
  expect(host.ctx.vfsRepo.mindmaps.getVersions(db(), old.mindmap.id)).toHaveLength(2);
  const diff = await execute('mindmap_diff_versions', { mindmap_id: old.mindmap.id, from_version_id: old.versionId, to_version_id: current.versionId });
  expect(diff.success).toBe(true);
  expect(diff.output).toMatchObject({ summary: { fromNodeCount: 5, toNodeCount: 5, added: 1, removed: 1, modified: 1, moved: 1, totalChanges: 4 },
    changes: { added: [{ id: 'new', path: 'root/New' }], removed: [{ id: 'old', path: 'root/Old' }], modified: [{ id: 'a' }], moved: [{ id: 'move', beforeParentId: 'a', afterParentId: 'b' }] } });
  const versions = await execute('mindmap_versions', { mindmap_id: old.mindmap.id, limit: 0 });
  expect(versions.output).toMatchObject({ count: 1, versions: [expect.objectContaining({ label: null, source: expect.any(String) })] });
});
it('rolls back an update when the required after-version fails but retains creation when its best-effort snapshot fails', async () => {
  const created = await execute('mindmap_create', { title: 'Rollback map' });
  const id = (created.output as { mindmap: { id: string } }).mindmap.id;
  const previous = host.ctx.vfsRepo.mindmaps.getMindmapContent(db(), id);
  db().exec("CREATE TRIGGER tool_snapshot_failure BEFORE INSERT ON mindmap_versions BEGIN SELECT RAISE(ABORT, 'snapshot denied'); END");
  try {
    const updated = await execute('mindmap_update', { mindmap_id: id, content: { root: { id: 'root', text: 'Changed' } } });
    expect(updated.success).toBe(false); expect(updated.error).toContain('Failed to update mindmap:');
    expect(host.ctx.vfsRepo.mindmaps.getMindmapContent(db(), id)).toBe(previous);
    const fresh = await execute('mindmap_create', { title: 'Creation survives' });
    expect(fresh.success).toBe(true); expect(fresh.output).not.toHaveProperty('versionId');
    expect(host.ctx.vfsRepo.mindmaps.getMindmap(db(), (fresh.output as { mindmap: { id: string } }).mindmap.id)).not.toBeNull();
  } finally { db().exec('DROP TRIGGER tool_snapshot_failure'); }
});
it('preserves historical version snapshots immutably via copy-on-write and diffs mindmap_edit_nodes changes', async () => {
  const created = await execute('mindmap_create', { title: 'Versioned history', content: { root: { id: 'alias-root', text: 'Original root', children: [{ id: 'c1', text: 'Existing' }] } } });
  const old = created.output as { mindmap: { id: string }; versionId: string };
  const edited = await execute('mindmap_edit_nodes', { mindmap_id: old.mindmap.id, operations: [
    { type: 'add_node', parent_id: 'alias-root', data: { id: 'c2', text: 'Added 1' } },
    { type: 'add_node', parent_id: 'alias-root', data: { id: 'c3', text: 'Added 2' } },
  ] });
  expect(edited.success).toBe(true);
  const post = edited.output as { versionId: string };
  const repo = host.ctx.vfsRepo.mindmaps;
  expect(JSON.parse(repo.getVersionContent(db(), old.versionId)!).root.children).toHaveLength(1);
  expect(JSON.parse(repo.getMindmapContent(db(), old.mindmap.id)!).root.children).toHaveLength(3);
  const diff = await execute('mindmap_diff_versions', { mindmap_id: old.mindmap.id, from_version_id: old.versionId, to_version_id: post.versionId });
  expect(diff.success).toBe(true);
  expect(diff.output).toMatchObject({ summary: { fromNodeCount: 2, toNodeCount: 4, added: 2, removed: 0, modified: 0, moved: 0, totalChanges: 2 } });
});
it('preserves Rust soft-delete reference counting and the legacy deleted path', async () => {
  const result = await execute('mindmap_create', { title: 'Delete map', content: { root: { id: 'delete-root', text: 'Unique delete fixture' } } });
  const id = (result.output as { mindmap: { id: string } }).mindmap.id;
  const resource = host.ctx.vfsRepo.mindmaps.getMindmap(db(), id)!.resourceId;
  const state = host.ctx.vfsRepo.indexStates.getIndexState(db(), resource);
  const deleted = await execute('mindmap_delete', { resource_id: id });
  expect(deleted.success).toBe(true);
  expect(deleted.output).toMatchObject({ deletedId: id });
  expect(deleted.output).not.toHaveProperty('warning');
  expect(host.ctx.vfsRepo.mindmaps.getMindmap(db(), id)).toBeNull();
  expect(db().pluck('SELECT resource_id FROM mindmaps WHERE id=?1', [id])).toBe(resource);
  // mindmap_repo.rs:866-875 counts even the just-deleted row, so cleanup is not entered.
  expect(host.ctx.vfsRepo.mindmaps.countActiveMindmapsByResourceId(db(), resource)).toBe(1);
  expect(host.ctx.vfsRepo.indexStates.getIndexState(db(), resource)).toEqual(state);
  expect(host.eventsNamed('dstu:change').at(-1)).toMatchObject({ type: 'deleted', path: `/mindmaps/${id}` });
});
it('commits valid backend node operations alongside errors, preserving descendants after an invalid move', async () => {
  const created = await execute('mindmap_create', { title: 'Node edits', content: { root: { id: 'root', text: 'Root', children: [
    { id: 'a', text: 'A', children: [{ id: 'b', text: 'B' }] },
  ] } } });
  const id = (created.output as { mindmap: { id: string } }).mindmap.id;
  const result = await execute('mindmap_edit_nodes', { mindmap_id: id, operations: JSON.stringify([
    { type: 'move_node', node_id: 'a', new_parent_id: 'b' }, { type: 'update_node', node_id: 'b', patch: { text: 'Updated B' } },
    { type: 'add_node', parent_id: 'root', data: { id: 'a', text: 'Duplicate becomes unique' } },
  ]), associations: [{ source: 'root', target: 'b' }] });
  expect(result.success).toBe(true);
  expect(result.output).toMatchObject({ success: false, appliedCount: 2, totalOperations: 3, associationsUpdated: true, plane: 'backend', delegated: false,
    errors: [expect.stringContaining("cannot move node 'a' into itself or its own descendant 'b'")], versionId: expect.stringMatching(/^mv_/) });
  const doc = JSON.parse(host.ctx.vfsRepo.mindmaps.getMindmapContent(db(), id)!);
  expect(doc.root.children[0].id).toBe('a'); expect(doc.root.children[0].children[0].text).toBe('Updated B');
  expect(doc.root.children[1].id).toMatch(/^n_.{8}$/); expect(doc.associations).toEqual([{ id: 'assoc_g1', source: 'root', target: 'b' }]);
});
it('keeps frontend suggestions out of backend storage and sends the exact probed window identity', async () => {
  const info = vi.spyOn(host.ctx.logger, 'info');
  const created = await execute('mindmap_create', { title: 'Delegated map', content: { root: { id: 'root', text: 'Original' } } });
  const id = (created.output as { mindmap: { id: string } }).mindmap.id;
  const before = host.ctx.vfsRepo.mindmaps.getMindmapContent(db(), id);
  const requests: Record<string, unknown>[] = [];
  delegationEnabled = true;
  const listener = await host.ctx.plugin(scope => { scope.backendEvents.listen(ACR_BRIDGE_REQUEST, payload => {
    const request = payload as { correlationId: string; bridgeToken: string; command: string; args: Record<string, unknown> };
    requests.push(request);
    host.emitFrontend(`${ACR_BRIDGE_RESPONSE_PREFIX}${request.correlationId}`, { correlationId: request.correlationId, bridgeToken: request.bridgeToken, ok: true,
      data: request.command === 'probe' ? { state: 'hot', windowId: 'exact-mindmap-window' } : {
        status: 'completed', mode: 'suggestion', applied: 1, totalOps: 1, entityIds: [id], done: ['suggested'], undone: [], suggestionPending: true,
      } });
  }); });
  try {
    const result = await execute('mindmap_edit_nodes', { mindmap_id: id, operations: [{ type: 'update_node', node_id: 'root', patch: { text: 'Suggested' } }] });
    expect(result.success).toBe(true); expect(result.output, JSON.stringify(info.mock.calls)).toMatchObject({ success: true, mode: 'suggestion', plane: 'suggestion', delegated: true, suggestionPending: true });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ args: { target: { windowId: 'exact-mindmap-window', resourceId: id }, destructive: false, pacing: 'normal' } });
    expect(host.ctx.vfsRepo.mindmaps.getMindmapContent(db(), id)).toBe(before);
  } finally { await listener.dispose(); delegationEnabled = false; info.mockRestore(); }
});
it('does not fall back to backend after apply_ops is submitted and its receipt fails', async () => {
  const created = await execute('mindmap_create', { title: 'Unknown outcome', content: { root: { id: 'root', text: 'Untouched' } } });
  const id = (created.output as { mindmap: { id: string } }).mindmap.id;
  const before = host.ctx.vfsRepo.mindmaps.getMindmapContent(db(), id);
  delegationEnabled = true;
  const listener = await host.ctx.plugin(scope => { scope.backendEvents.listen(ACR_BRIDGE_REQUEST, payload => {
    const request = payload as { correlationId: string; bridgeToken: string; command: string };
    host.emitFrontend(`${ACR_BRIDGE_RESPONSE_PREFIX}${request.correlationId}`, { correlationId: request.correlationId, bridgeToken: request.bridgeToken,
      ...(request.command === 'probe' ? { ok: true, data: { state: 'clean', windowId: 'w' } } : { ok: false, error: 'write receipt unavailable' }) });
  }); });
  try {
    const result = await execute('mindmap_edit_nodes', { mindmap_id: id, operations: [{ type: 'update_node', node_id: 'root', patch: { text: 'Possibly applied' } }] });
    expect(result.success).toBe(true); expect(result.output).toMatchObject({ code: 'RESULT_UNKNOWN', resultUnknown: true, applied: null, retryable: false });
    expect(host.ctx.vfsRepo.mindmaps.getMindmapContent(db(), id)).toBe(before);
  } finally { await listener.dispose(); delegationEnabled = false; }
});
