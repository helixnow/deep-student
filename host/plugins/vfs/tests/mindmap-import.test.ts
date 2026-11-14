import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import { isVirtualUri } from '../../../platform/storage/unified-file-manager.ts';
import { writeZip } from '../../../platform/util/node.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import agentPlugin from '../../agent-skills/index.ts';
import notesPlugin from '../../notes/index.ts';
import reposPlugin from '../../vfs-repos/index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import chatPlugin from '../../chat/index.ts';
import { ChatV2Emitter, BackendEventsSink } from '../../chat/api.ts';
import plugin from '../index.ts';
import type { MindmapXmlNode, MindmapXmlParser } from '../api.ts';
import type { BuiltinResourceExecutor, ResourceToolContext } from '../src/tools/resource-executor.ts';

// Only XML tokenization is external; all format conversion and persistence is production code.
const xml: MindmapXmlParser = { parse(text) {
  const dom = new JSDOM(text, { contentType: 'text/xml' });
  const convert = (node: Node): MindmapXmlNode => {
    const element = node.nodeType === 1 ? node as Element : null;
    return { kind: element ? 'element' : node.nodeType === 3 || node.nodeType === 4 ? 'text' : 'other',
      localName: element?.localName ?? '', text: node.nodeType === 3 || node.nodeType === 4 ? node.nodeValue : null,
      attributes: element ? [...element.attributes].map(attr => ({ localName: attr.localName, namespace: attr.namespaceURI, value: attr.value })) : [],
      children: [...node.childNodes].map(convert) };
  };
  try { return convert(dom.window.document.documentElement); } finally { dom.window.close(); }
} };
let root: string, host: TestHost, storage: ReturnType<typeof createStorageService>, ordinal = 0;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-import-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const report = await storage.migrations.runAll(); expect(report.success, report.error ?? '').toBe(true);
  const settings = createSettingsService({ db: () => storage.database('mistakes'), secureStore: () => null, secrets: { isSensitiveKey: () => false } });
  host = await createTestHost({ app: { dataDir: root }, provide: { storage, settings, mindmapXml: xml, virtualFilePolicy: { isVirtualUri } },
    plugins: [pathsPlugin, agentPlugin, notesPlugin, reposPlugin, indexPlugin, plugin, chatPlugin] });
  host.ctx.chatSession.createSession({ id: 'import-session', mode: 'chat', titleLocked: false, persistStatus: 'active', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
}, 120_000);
afterAll(async () => { await host?.dispose(); storage?.dispose(); if (root) fs.rmSync(root, { recursive: true, force: true }); });
async function importFile(name: string, bytes: Uint8Array, own = true, extra: Record<string, unknown> = {}) {
  const db = host.ctx.vfsDatabase.getConnSafe(), blob = host.ctx.vfsRepo.blobs.storeBlob(db, host.ctx.vfsDatabase.blobsDir(), bytes);
  const file = host.ctx.vfsRepo.files.createFile(db, `import-${++ordinal}`, name, bytes.length, 'document', 'application/octet-stream', blob.hash, null);
  if (own) host.ctx.chatSession.createMessage({ id: `import-message-${ordinal}`, sessionId: 'import-session', role: 'user', blockIds: [], timestamp: ordinal,
    _meta: { contextSnapshot: { userRefs: [{ resourceId: file.resourceId!, hash: 'hash', typeId: 'file' }] } } });
  const executor = host.ctx.agentTools.toolExecutors().find(e => e.canHandle('mindmap_import')) as BuiltinResourceExecutor;
  const emitter = new ChatV2Emitter(new BackendEventsSink(host.ctx.backendEvents), 'import-session', false);
  const context: ResourceToolContext = { services: host.ctx, session_id: 'import-session', chat_v2_db: host.ctx.chatSession.database,
    message_id: 'tool-msg', block_id: 'tool-block', variant_id: null, skill_state_version: null, round_id: null, emitter,
    emitToolCallStart(toolName, args, id) { emitter.emitStart('tool_call', 'tool-msg', 'tool-block', { toolName, args, id }, null); },
    saveToolBlock(result) { expect(result.toolName).toBe('builtin-mindmap_import'); } };
  const result = await executor.execute({ id: 'import-call', name: 'builtin-mindmap_import', arguments: { resourceId: file.resourceId, ...extra } }, context);
  const output = result.output as { mindmap: { id: string }; importStats: Record<string, unknown> } | null;
  const doc = output?.mindmap ? JSON.parse(host.ctx.vfsRepo.mindmaps.getMindmapContent(db, output.mindmap.id)!) as Record<string, any> : null;
  return { result, output, doc };
}
it('test_can_handle', () => {
  const values = host.ctx.agentTools.toolExecutors().filter(e => e.name() === 'BuiltinResourceExecutor');
  for (const tool of ['resource_list', 'resource_read', 'resource_search', 'folder_list', 'mindmap_create', 'mindmap_update', 'mindmap_delete', 'mindmap_versions', 'mindmap_diff_versions', 'mindmap_import']) {
    expect(values.some(e => e.canHandle(`builtin-${tool}`))).toBe(true);
  }
  for (const name of ['builtin-rag_search', 'builtin-web_search', 'note_read', 'mcp_brave_search']) expect(values.some(e => e.canHandle(name))).toBe(false);
});
it('imports heading/list/task outlines and rejects files outside the current session', async () => {
  const imported = await importFile('outline.md', Buffer.from('# Heading\n- [x] Done\n  - Child\n- [ ] Pending'));
  expect(imported.result.success).toBe(true); expect(imported.output!.importStats).toMatchObject({ format: 'markdown', nodeCount: 4, associationCount: 0 });
  expect(imported.doc!.root).toMatchObject({ id: 'root', text: 'Heading', children: [{ text: 'Done', completed: true, children: [{ text: 'Child' }] }, { text: 'Pending', completed: false }] });
  const unowned = await importFile('not-owned.json', Buffer.from('{"root":{"text":"x"}}'), false);
  expect(unowned.result.success).toBe(false); expect(unowned.result.error).toContain('not available in the current chat session');
});
it('imports JSON ids, clears invalid associations, and enforces node depth before writing', async () => {
  const imported = await importFile('mindmap.json', Buffer.from(JSON.stringify({ root: { text: 'Root', children: [{ text: 'Child' }] }, associations: [{ source: 'root', target: 'n1' }] })));
  expect(imported.result.success).toBe(true); expect(imported.doc!.associations).toEqual([{ id: 'assoc_g1', source: 'root', target: 'n1' }]);
  const rootNode: any = { text: 'root' }; let leaf = rootNode;
  for (let depth = 0; depth < 101; depth++) { leaf.children = [{ text: 'deep' }]; leaf = leaf.children[0]; }
  const deep = await importFile('deep.json', Buffer.from(JSON.stringify({ root: rootNode })));
  expect(deep.result.success).toBe(false); expect(deep.result.error).toBe('无效的导图 JSON: recursion limit exceeded at line 1 column 1710');
  const outline = await importFile('deep.md', Buffer.from(`${' '.repeat(202)}too deep`));
  expect(outline.result.success).toBe(false); expect(outline.result.error).toBe('导入内容层级过深，超过最大限制（100 层）');
});
it('imports XMind JSON relationships and reports exactly the unsupported features it drops', async () => {
  const bytes = writeZip([{ name: 'content.json', data: Buffer.from(JSON.stringify([{ rootTopic: { id: 'r', title: 'Map', image: null,
    summaries: [{}], boundaries: [{}, {}], href: 'https://example.test', notes: { html: { content: '<b>note</b>' } },
    children: { attached: [{ id: 'c', title: 'Task', markers: [{ markerId: 'task-done' }] }] } }, relationships: [{ end1Id: 'r', end2Id: 'c', title: 'Link' }] }])) }]);
  const imported = await importFile('sample.xmind', bytes);
  expect(imported.result.success).toBe(true); expect(imported.output!.importStats).toMatchObject({ format: 'xmind', nodeCount: 2, associationCount: 1,
    droppedImages: 1, droppedSummaries: 1, droppedBoundaries: 2, droppedHyperlinks: 1 });
  expect(imported.doc!.root).toMatchObject({ note: 'note', children: [{ completed: true }] });
  expect(imported.doc!.associations).toEqual([{ id: 'assoc_1', source: 'root', target: 'n1', label: 'Link' }]);
});
it('converts OPML and FreeMind using the supplied XML tree without duplicating text descendants', async () => {
  const opml = await importFile('sample.opml', Buffer.from('<opml><body><outline text="Root"><outline text="Done" _complete="true" _note="note"/></outline></body></opml>'));
  expect(opml.result.success).toBe(true); expect(opml.doc!.root).toMatchObject({ id: 'root', children: [{ id: 'n1', text: 'Done', completed: true, note: 'note' }] });
  const mm = await importFile('sample.mm', Buffer.from('<map><node ID="a"><richcontent TYPE="NODE"><html><b>Rich</b> root</html></richcontent><node ID="b" TEXT="Child"><icon BUILTIN="button_ok"/></node><arrowlink DESTINATION="b" MIDDLE_LABEL="edge"/></node></map>'));
  expect(mm.result.success).toBe(true); expect(mm.doc!.root).toMatchObject({ text: 'Rich root', children: [{ id: 'n1', text: 'Child', completed: true }] });
  expect(mm.doc!.associations).toEqual([{ id: 'assoc_1', source: 'root', target: 'n1', label: 'edge' }]);
});
it('supports XMind XML and extensionless MMap fallback with reset counters', async () => {
  const xmind = await importFile('sample.xmind', writeZip([{ name: 'content.xml', data: Buffer.from('<xmap><sheet><topic id="a"><title>XML root</title><children><topics><topic id="b"><title>Child</title></topic></topics></children></topic><relationships><relationship end1="a" end2="b"><title>Link</title></relationship></relationships></sheet></xmap>') }]));
  expect(xmind.result.success).toBe(true); expect(xmind.output!.importStats).toMatchObject({ nodeCount: 2, associationCount: 1 });
  const mmap = await importFile('unknown.bin', writeZip([{ name: 'Document.xml', data: Buffer.from('<Document><OneTopic><Topic><Text PlainText="MMap root"/><SubTopics><Topic><Text PlainText="Child"/></Topic></SubTopics></Topic></OneTopic></Document>') }]));
  expect(mmap.result.success).toBe(true); expect(mmap.output!.importStats).toMatchObject({ format: 'mmap', nodeCount: 2 });
  expect(mmap.doc!.root).toMatchObject({ id: 'root', text: 'MMap root', children: [{ id: 'n1', text: 'Child' }] });
});
