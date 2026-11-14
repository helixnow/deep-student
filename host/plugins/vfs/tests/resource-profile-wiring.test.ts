/** Resource, mindmap and attachment tools under the official desktop profile, run through the chat-pipeline tool
 * runtime. Executors receive the chat-pipeline context as `services`; it injects only chat-pipeline's own
 * dependencies, so vfs-side services must be read with `get` (unit tests pass the root context and cannot see this).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { CapabilityAcl } from '../../../kernel/acl.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { BackendEventsSink, ChatV2Emitter, type ToolResultInfo } from '../../chat/api.ts';
import type { ToolRuntimeAuthorityOwner, ToolRuntimeTodoOwner } from '../../chat-pipeline/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';

const SESSION = 'sess-resource-profile';
const unreachable = (): never => { throw new Error('authority/todo owners are outside the resource tool path'); };
const authority: ToolRuntimeAuthorityOwner = { getSessionAuthorityState: unreachable, createPendingPlan: unreachable,
  setSessionPlanState: unreachable, consumeSessionPlanBinding: unreachable };
const todo: ToolRuntimeTodoOwner = { getTodoList: unreachable, persistTodoList: unreachable };

let root = '';
let host: TestHost;
let note: { id: string; resourceId: string };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dstu-resource-profile-'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  host = await createTestHost({ app: { dataDir: join(root, 'app'), platform: 'linux' }, acl: CapabilityAcl.fromDirectory('linux') });
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  expect(loaded.degraded).toEqual([]);
  host.ctx.chatSession.createSession({ id: SESSION, mode: 'chat', titleLocked: true, persistStatus: 'active',
    createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' });
  host.ctx.chatSession.createMessage({ id: 'msg-resource-att', sessionId: SESSION, role: 'user', blockIds: [], timestamp: 1,
    attachments: [{ id: 'att_profile_doc', name: 'chapter.md', type: 'document', mimeType: 'application/octet-stream', size: 21,
      previewUrl: `data:application/octet-stream;base64,${Buffer.from('第一章 线性回归').toString('base64')}`, status: 'ready' }] });
  note = host.ctx.notes.repository.createNote({ title: '线性代数笔记', content: '特征值分解把矩阵写成 PDP⁻¹', tags: [] },
    host.ctx.vfsDatabase.getConnSafe());
}, 120_000);
beforeEach(() => { host.events.length = 0; });
afterAll(async () => {
  await host?.dispose();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

type Runtime = ReturnType<TestHost['ctx']['chatPipeline']['bindToolRuntime']>;
type Init = Parameters<Runtime['execute']>[1];
function init(callId: string): Init {
  return { sessionId: SESSION, messageId: 'msg-resource-profile', blockId: `blk-${callId}`,
    emitter: new ChatV2Emitter(new BackendEventsSink(host.ctx.backendEvents), SESSION, false), toolCallId: callId,
    canvasNoteId: null, ragTopK: null, ragEnableReranking: null, variantId: null, skillStateVersion: null, roundId: null,
    executionAllowedTools: null, skillPackageRoots: null, questionAuthoringConfig: null, shellGuardApproved: false,
    memoryEnabled: true, ragEnabled: true, webSearchEnabled: true, shellAuthorityAdmission: null, skillContents: null,
    skillEmbeddedTools: null, skillAdmissionErrors: null, cancellation: null,
    dispatcher: unreachable, admittedDispatcher: { dispatchWithAdmission: unreachable } as unknown as Init['admittedDispatcher'] };
}
async function run(name: string, args: JsonValue): Promise<Record<string, unknown>> {
  const runtime = host.ctx.chatPipeline.bindToolRuntime(authority, todo);
  const result: ToolResultInfo = await runtime.execute({ id: `call-${name}`, name, arguments: args }, init(`call-${name}`));
  expect(result.success, result.error ?? '').toBe(true);
  return result.output as Record<string, unknown>;
}

it('resource_read, resource_list, resource_search and folder_list reach the VFS database', async () => {
  expect(await run('builtin-resource_read', { resource_id: note.id })).toMatchObject({ content: '特征值分解把矩阵写成 PDP⁻¹',
    resolvedResourceId: note.id, type: 'notes' });
  expect(await run('builtin-resource_list', { type: 'note' })).toMatchObject({ count: 1, items: [expect.objectContaining({ id: note.id })] });
  expect(await run('builtin-resource_search', { query: '特征值' })).toMatchObject({ count: 1,
    items: [expect.objectContaining({ id: note.id, snippet: '特征值分解把矩阵写成 PDP⁻¹' })] });
  expect(await run('builtin-folder_list', {})).toMatchObject({ success: true });
});

it('mindmap create, update, edit, versions, diff and delete run against the VFS database', async () => {
  const created = await run('builtin-mindmap_create', { title: '特征值导图', content: { root: { id: 'root', text: '特征值' } } });
  const id = (created.mindmap as { id: string }).id;
  expect(host.eventsNamed('dstu:change')).toEqual([expect.objectContaining({ type: 'created' })]);
  const updated = await run('builtin-mindmap_update', { mindmap_id: id,
    content: { root: { id: 'root', text: '特征值', children: [{ id: 'a', text: '特征向量' }] } } });
  const edited = await run('builtin-mindmap_edit_nodes', { mindmap_id: id,
    operations: [{ type: 'update_node', node_id: 'a', patch: { text: '特征多项式' } }] });
  expect(edited).toMatchObject({ success: true, appliedCount: 1, plane: 'backend' });
  expect(JSON.parse(host.ctx.vfsRepo.mindmaps.getMindmapContent(host.ctx.vfsDatabase.getConnSafe(), id)!).root.children[0].text)
    .toBe('特征多项式');
  expect(await run('builtin-mindmap_versions', { mindmap_id: id })).toMatchObject({ mindmapId: id, versions: expect.arrayContaining([
    expect.objectContaining({ versionId: created.versionId }), expect.objectContaining({ versionId: updated.versionId })]) });
  // Version snapshots share the live document's deduplicated resource (Rust); only the wiring is asserted here.
  expect(await run('builtin-mindmap_diff_versions', { mindmap_id: id, from_version_id: created.versionId as string,
    to_version_id: updated.versionId as string })).toMatchObject({ mindmapId: id, to: { versionId: updated.versionId } });
  expect(await run('builtin-mindmap_delete', { resource_id: id })).toMatchObject({ deletedId: id });
});

it('mindmap_import resolves a session file and its blob through the VFS database', async () => {
  const db = host.ctx.vfsDatabase.getConnSafe(), bytes = Buffer.from('# 特征值\n- 特征向量\n- 特征多项式');
  const blob = host.ctx.vfsRepo.blobs.storeBlob(db, host.ctx.vfsDatabase.blobsDir(), bytes);
  const file = host.ctx.vfsRepo.files.createFile(db, 'import-profile', 'eigen.md', bytes.length, 'document', 'application/octet-stream', blob.hash, null);
  host.ctx.chatSession.createMessage({ id: 'msg-resource-import', sessionId: SESSION, role: 'user', blockIds: [], timestamp: 2,
    _meta: { contextSnapshot: { userRefs: [{ resourceId: file.resourceId!, hash: 'hash', typeId: 'file' }] } } });
  const imported = await run('builtin-mindmap_import', { resourceId: file.resourceId! });
  expect(imported).toMatchObject({ importStats: { format: 'markdown', sourceFileName: 'eigen.md', nodeCount: 3 } });
  const doc = JSON.parse(host.ctx.vfsRepo.mindmaps.getMindmapContent(db, (imported.mindmap as { id: string }).id)!);
  expect(doc.root.text).toBe('特征值');
});

it('attachment_read parses an inline document through the docs service', async () => {
  expect(await run('builtin-attachment_read', { message_id: 'msg-resource-att', attachment_id: 'att_profile_doc' }))
    .toMatchObject({ content: '第一章 线性回归' });
});
