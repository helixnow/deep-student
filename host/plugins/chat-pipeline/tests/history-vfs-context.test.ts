import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPipelineHost } from './chat-host.ts';
import type { ChatMessage, ContextRef } from '../../chat/api.ts';
import type { VfsContextRefData } from '../../agent-workspace/api.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
beforeAll(async () => { host = await createPipelineHost({ vfs: true }); }, 60_000);
afterAll(async () => { await host?.dispose(); });
const message = (refs: ContextRef[]): ChatMessage => ({ id: 'msg_history_vfs', sessionId: 'sess_history',
  role: 'user', blockIds: [], timestamp: 0, _meta: { contextSnapshot: { userRefs: refs, retrievalRefs: [] } } });
function resource(data: string, typeId = 'file', title?: string): ContextRef {
  const result = host.ctx.vfsRepo.resources.createOrReuse(host.ctx.vfs.database.getConnSafe(),
    'file', data, null, null, title === undefined ? null : { title });
  return { resourceId: result.resourceId, hash: result.hash, typeId };
}
function resolve(original: string, msg: ChatMessage) {
  return host.ctx.chatPipeline.resolveHistoryContextSnapshot(original, msg, host.ctx.vfs.database.getConnSafe());
}

describe('history.rs:578–712 injected L05 VFS resolver', () => {
  it('test_resolved_content: no user refs preserves original content without invoking the resolver', async () => {
    const resolver = host.ctx.agentVfsResolver;
    const spy = vi.spyOn(resolver, 'resolveContextRefDataToContent');
    try {
      await expect(resolve('unchanged', message([]))).resolves.toEqual(['unchanged', []]);
      await expect(resolve('no meta', { ...message([]), _meta: undefined })).resolves.toEqual(['no meta', []]);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('test_resolved_content: restores original image bytes from an old OCR-only turn through L05', async () => {
    const { vfs, vfsRepo } = host.ctx;
    const db = vfs.database.getConnSafe();
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const blob = vfsRepo.blobs.storeBlob(db, vfs.database.blobsDir(), bytes, 'image/png', 'png');
    const file = vfsRepo.files.createFile(db, blob.hash, 'original.png', bytes.length, 'image', 'image/png', blob.hash);
    const data: VfsContextRefData = { refs: [{ sourceId: file.id, resourceHash: blob.hash,
      type: 'image', name: 'original.png', injectModes: { image: ['ocr'] } }] };
    const ref = resource(JSON.stringify(data));
    const resolver = host.ctx.agentVfsResolver;
    const spy = vi.spyOn(resolver, 'resolveContextRefDataToContent');
    try {
      await expect(resolve('look at it', message([ref]))).resolves.toEqual(['look at it', [bytes.toString('base64')]]);
      expect(spy).toHaveBeenCalledExactlyOnceWith({ ...data, truncated: false, totalCount: 0,
        refs: [{ ...data.refs[0], injectModes: { image: ['image'], pdf: null } }] }, true);
      expect(JSON.parse(vfsRepo.resources.getResource(db, ref.resourceId)!.data!)).toEqual(data);
    } finally { spy.mockRestore(); }
  });

  it('test_escape_xml_attr: file/textbook modes are reset and XML escaping stays in L05', async () => {
    const { vfs, vfsRepo } = host.ctx;
    const db = vfs.database.getConnSafe();
    const name = 'a"<&.txt';
    const file = vfsRepo.files.createFileWithDocDataInFolder(db, 'history-native-text', name, 4,
      'document', 'text/plain', null, null, null, null, 'native <& text', null);
    const data: VfsContextRefData = { refs: [{ sourceId: file.id, resourceHash: file.sha256,
      type: 'file', name, injectModes: { pdf: ['ocr'] } },
    { sourceId: 'missing-textbook', resourceHash: 'missing', type: 'textbook', name: 'book', injectModes: { pdf: [] } }] };
    const ref = resource(JSON.stringify(data));
    const resolver = host.ctx.agentVfsResolver;
    const spy = vi.spyOn(resolver, 'resolveContextRefDataToContent');
    try {
      const [text] = await resolve('question', message([ref]));
      expect(text).toContain('<file name="a&quot;&lt;&amp;.txt">native &lt;&amp; text</file>');
      expect(text.endsWith('\n\n---\n\nquestion')).toBe(true);
      expect(spy.mock.calls[0]![0].refs.map(r => r.injectModes)).toEqual([
        { image: null, pdf: ['text', 'image'] }, { image: null, pdf: ['text', 'image'] },
      ]);
      expect(spy.mock.calls[0]![1]).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('preserves inline fallback order and logs missing/failed/unknown resource branches', async () => {
    const first = resource('raw <note>', 'note', 'Title<&');
    const second = resource('{"refs":[{"sourceId":"invalid"}]}', 'translation');
    const unknown = resource('plain unknown', 'unsupported');
    const noData = host.ctx.vfsRepo.resources.createOrReuseExternal(host.ctx.vfs.database.getConnSafe(),
      'file', 'external-history', 'external-blob', null, null, null);
    const failing: ContextRef = { resourceId: 'read-error', hash: '', typeId: 'file' };
    const missing: ContextRef = { resourceId: 'absent', hash: '', typeId: 'file' };
    const repo = host.ctx.vfsRepo.resources;
    const get = repo.getResource.bind(repo);
    const lookup = vi.spyOn(repo, 'getResource').mockImplementation((conn, id) => {
      if (id === failing.resourceId) throw new Error('read failed');
      return get(conn, id);
    });
    const warn = vi.spyOn(host.ctx.logger, 'warn');
    const info = vi.spyOn(host.ctx.logger, 'info');
    const debug = vi.spyOn(host.ctx.logger, 'debug');
    try {
      await expect(resolve('user', message([first, missing, failing, second, unknown,
        { resourceId: noData.resourceId, hash: noData.hash, typeId: 'file' }]))).resolves.toEqual([
        '<injected_context>\n[Title<&]\nraw <note>\n</injected_context>\n\n'
        + '<injected_context>\n[translation]\n{"refs":[{"sourceId":"invalid"}]}\n</injected_context>\n\n---\n\nuser', [],
      ]);
      expect(warn).toHaveBeenCalledWith('[ChatV2::pipeline] Resource not found: absent');
      expect(warn).toHaveBeenCalledWith('[ChatV2::pipeline] Failed to get resource read-error: read failed');
      expect(info).toHaveBeenCalledWith('[ChatV2::pipeline] Resolved 2 context items and 0 images for message msg_history_vfs');
      expect(debug).toHaveBeenCalledWith(`[ChatV2::pipeline] Resource ${noData.resourceId} has no data`);
      expect(debug).toHaveBeenCalledWith(`[ChatV2::pipeline] Unknown type_id for resource ${unknown.resourceId}: unsupported`);
    } finally { lookup.mockRestore(); warn.mockRestore(); info.mockRestore(); debug.mockRestore(); }
  });

  it('keeps non-image modes and rejects malformed serde reference containers before resolver dispatch', async () => {
    const resolver = host.ctx.agentVfsResolver;
    const spy = vi.spyOn(resolver, 'resolveContextRefDataToContent');
    const valid = { refs: [{ sourceId: 'retrieval_1', resourceHash: 'h', type: { retrieval: null },
      name: 'retrieved', snippet: 'source text', injectModes: { pdf: [{ ocr: null }] } }],
    truncated: true, totalCount: 9 };
    const bad = [
      { refs: [], truncated: null }, { refs: [], totalCount: -1 },
      { refs: [{ sourceId: 'x', resourceHash: 'h', type: 'image', name: 'x', injectModes: { image: ['unknown'] } }] },
      { refs: [{ sourceId: 'x', resourceHash: 'h', type: 'image', name: 'x', snippet: 1 }] },
    ];
    try {
      for (const input of bad) {
        const raw = JSON.stringify(input);
        const [text, images] = await resolve('user', message([resource(raw, 'note')]));
        expect(text).toBe(`<injected_context>\n[note]\n${raw}\n</injected_context>\n\n---\n\nuser`);
        expect(images).toEqual([]);
      }
      expect(spy).not.toHaveBeenCalled();
      const [text] = await resolve('user', message([resource(JSON.stringify(valid))]));
      expect(text).toContain('<retrieval source="retrieval_1">source text</retrieval>');
      expect(spy).toHaveBeenCalledExactlyOnceWith({ ...valid, refs: [{ ...valid.refs[0],
        type: 'retrieval', injectModes: { pdf: ['ocr'] } }] }, true);
    } finally { spy.mockRestore(); }
  });
});
