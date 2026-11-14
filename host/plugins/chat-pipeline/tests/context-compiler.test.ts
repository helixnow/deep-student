import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPipelineHost } from './chat-host.ts';
import type { CanonicalContentPart } from '../../chat/api.ts';
import type { ContextCompilationPorts, PipelineContext } from '../api.ts';
import { imagePart } from '../api.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
let imageHash: string, invalidHash: string;
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2]);
beforeAll(async () => {
  host = await createPipelineHost({ vfs: true, llm: true });
  await host.ctx.llm.saveApiConfigurations([
    { id: 'text', name: 'text', model: 'text-model', baseUrl: 'https://provider.invalid/v1',
      apiKey: 'test-key', enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false },
    { id: 'vision', name: 'vision', model: 'vision-model', baseUrl: 'https://provider.invalid/v1',
      apiKey: 'test-key', enabled: true, isMultimodal: true, isReasoning: false, isEmbedding: false, isReranker: false },
  ]);
  const db = host.ctx.vfs.database;
  imageHash = host.ctx.vfsRepo.blobs.storeBlob(db.getConnSafe(), db.blobsDir(), bytes, 'image/png', 'png').hash;
  invalidHash = host.ctx.vfsRepo.blobs.storeBlob(db.getConnSafe(), db.blobsDir(), Buffer.from('%PDF-invalid-image'), 'application/pdf', 'pdf').hash;
}, 60_000);
afterAll(async () => { await host?.dispose(); });

function image(id: string, hash = imageHash): CanonicalContentPart {
  return { type: 'image_ref', image_id: id, blob_hash: hash, mime_type: 'image/jpeg', pinned: false, retrieval_hit: false };
}
function ports(): ContextCompilationPorts {
  return {
    resolveCanonicalImages: parts => host.ctx.chatPipeline.resolveCanonicalImagePayloads(parts, () => {
      throw new Error('fixture has explicit blob hashes; file fallback must not be used');
    }),
    observeImages: vi.fn(async () => { throw new Error('unexpected auxiliary call'); }),
    ocrImage: vi.fn(async () => { throw new Error('unexpected OCR call'); }),
  };
}
async function turn(modelId: string, canonical: CanonicalContentPart[]): Promise<PipelineContext> {
  const execution = host.ctx.chatPipeline.createPipelineContext({ sessionId: `compiler-${modelId}`, content: 'hello & <world>',
    options: { modelId } });
  execution.runtimeFacts = 'frozen runtime facts';
  execution.turnVolatileContext = '<active_goal>frozen goal</active_goal>';
  await host.ctx.chatPipeline.freezeExecutionContext(execution, () => canonical);
  return execution;
}

describe('P1 frozen context compiler: real Host/L02 freeze/L11 blobs; explicit external visual-operation ports', () => {
  it('fails before hydration if the model was not frozen', async () => {
    const execution = host.ctx.chatPipeline.createPipelineContext({ sessionId: 'not-frozen', content: 'hello' });
    const owner = ports(); const resolve = vi.spyOn(owner, 'resolveCanonicalImages');
    await expect(host.ctx.chatPipeline.compileFrozenContext(execution, owner))
      .rejects.toThrow('model execution snapshot was not frozen');
    expect(resolve).not.toHaveBeenCalled();
    expect(execution.compiledCurrentUserMessage).toBeNull();
  });

  it('uses frozen runtime facts and appends volatile context to user content, preserving history', async () => {
    const execution = await turn('text', [{ type: 'text', text: 'hello & <world>' }]);
    const history = [{ role: 'assistant', content: 'previous', metadata: { untouched: true } }];
    execution.chatHistory = history;
    const owner = ports();
    await host.ctx.chatPipeline.compileFrozenContext(execution, owner);
    expect(execution.compiledCurrentUserMessage).toMatchObject({ role: 'user',
      content: '<user_query>\nhello &amp; &lt;world&gt;\n</user_query>\n\n<injected_context>\nfrozen runtime facts\n\n<active_goal>frozen goal</active_goal>\n</injected_context>',
      metadata: { canonicalContent: [{ type: 'text', text: 'hello & <world>' }] },
      multimodal_content: null, image_base64: null, doc_attachments: null });
    // images.rs::strip_all_images normalizes the legacy image field to None even for text-only history.
    expect(execution.chatHistory).toEqual([{ role: 'assistant', content: 'previous',
      metadata: { untouched: true }, image_base64: null }]);
    expect(execution.chatHistory).not.toBe(history);
    expect(execution.executionSnapshot?.executionRoute).toBe('text_model_direct');
    expect(owner.observeImages).not.toHaveBeenCalled();
    expect(owner.ocrImage).not.toHaveBeenCalled();
  });

  it('hydrates original blob bytes and actual MIME, then reserves current-image budget ahead of history', async () => {
    const execution = await turn('vision', [image('current')]);
    const history = [0, 1].map(n => ({ role: 'user', content: `history-${n}`,
      multimodal_content: [imagePart('image/jpeg', 'preview')], metadata: { canonicalContent: [image(`history-${n}`)] } }));
    execution.chatHistory = history;
    execution.executionSnapshot!.generationPlan.imageBudget = 2;
    execution.executionSnapshot!.generationPlan.historyImageBudget = 1;
    await host.ctx.chatPipeline.compileFrozenContext(execution, ports());
    expect(execution.compiledCurrentUserMessage?.multimodal_content).toContainEqual({
      type: 'image_url', mediaType: 'image/png', base64: bytes.toString('base64'),
    });
    expect(execution.chatHistory[1]?.multimodal_content).toEqual([
      { type: 'image_url', mediaType: 'image/png', base64: bytes.toString('base64') },
    ]);
    expect(execution.chatHistory[0]?.multimodal_content).toEqual([
      { type: 'text', text: '[1 张较早图片因上下文图片预算未重复发送，原始引用仍保留。]' },
    ]);
    expect(history[0]?.multimodal_content).toEqual([{ type: 'image_url', mediaType: 'image/jpeg', base64: 'preview' }]);
    expect(execution.executionSnapshot?.executionRoute).toBe('multimodal_model_direct');
  });

  it('reuses the owning message artifact without contacting auxiliary MM or OCR', async () => {
    const canonical: CanonicalContentPart[] = [image('current'), { type: 'derived_artifact_ref', artifact_id: 'saved-ocr',
      artifact_type: 'ocr_text', source_image_ids: ['current'], content: 'previous OCR', created_at: 42 }];
    const execution = await turn('text', canonical);
    const owner = ports();
    await host.ctx.chatPipeline.compileFrozenContext(execution, owner);
    expect(execution.compiledCurrentUserMessage?.content).toContain('<derived_visual_observation>\nprevious OCR\n</derived_visual_observation>');
    expect(execution.compiledCurrentUserMessage?.multimodal_content).toBeNull();
    expect(execution.compiledCurrentUserMessage?.image_base64).toBeNull();
    expect(execution.executionSnapshot?.executionRoute).toBe('ocr_then_text_model');
    expect(execution.canonicalContent).toEqual(canonical);
    expect(owner.observeImages).not.toHaveBeenCalled();
    expect(owner.ocrImage).not.toHaveBeenCalled();
  });

  it('processes current images first, falls back from empty auxiliary to OCR, and persists only current artifacts', async () => {
    const execution = await turn('text', [image('current')]);
    execution.chatHistory = [{ role: 'user', content: 'history', metadata: { canonicalContent: [image('old')] } }];
    execution.executionSnapshot!.capabilitySnapshot.ocr = { configured: true, healthy: true,
      circuitOpen: false, protocolCompatible: true, indexCompatible: true };
    const order: string[] = [];
    const payloads: unknown[] = [];
    const owner = ports();
    owner.observeImages = vi.fn(async (_config, _prompt, images) => {
      payloads.push(images);
      order.push('auxiliary'); return ' \n';
    });
    owner.ocrImage = vi.fn(async image => { order.push(image.imageId); return `OCR-${image.imageId}`; });
    await host.ctx.chatPipeline.compileFrozenContext(execution, owner);
    expect(order).toEqual(['auxiliary', 'current', 'auxiliary', 'old']);
    // images.rs:224–249 keeps canonical_mime for auxiliary inputs; direct-MM parts use sniffed MIME.
    expect(payloads).toEqual([
      [{ mime: 'image/jpeg', base64: bytes.toString('base64') }],
      [{ mime: 'image/jpeg', base64: bytes.toString('base64') }],
    ]);
    expect(execution.canonicalContent).toHaveLength(2);
    expect(execution.canonicalContent[1]).toMatchObject({ type: 'derived_artifact_ref', artifact_type: 'ocr_text',
      source_image_ids: ['current'], producer_model_id: null, content: 'OCR-current' });
    expect(execution.compiledCurrentUserMessage?.content).toContain('OCR-current');
    expect(execution.chatHistory[0]?.content).toContain('OCR-old');
    expect(execution.executionSnapshot?.executionRoute).toBe('ocr_then_text_model');
  });

  it('unavailable visual output is request-local and cannot suppress a future retry', async () => {
    const execution = await turn('text', [image('current')]);
    const owner = ports(); owner.observeImages = vi.fn(async () => { throw new Error('remote failed'); });
    execution.executionSnapshot!.capabilitySnapshot.ocr.configured = false;
    await host.ctx.chatPipeline.compileFrozenContext(execution, owner);
    expect(execution.compiledCurrentUserMessage?.content).toContain('图片内容当前不可解析');
    expect(execution.canonicalContent).toEqual([image('current')]);
    expect(execution.executionSnapshot?.executionRoute).toBe('text_model_without_image');
    expect(owner.ocrImage).not.toHaveBeenCalled();
  });

  it('cancellation reaches the in-flight auxiliary operation and prevents compiled history publication', async () => {
    const execution = await turn('text', [image('current')]);
    const controller = new AbortController(); execution.setCancellationToken(controller.signal);
    const history = execution.chatHistory;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let stageSignal: AbortSignal | undefined;
    const owner = ports();
    owner.observeImages = (_id, _prompt, _images, signal) => new Promise((_resolve, reject) => {
      stageSignal = signal;
      signal.addEventListener('abort', () => reject(new Error('provider cancelled')), { once: true });
      started();
    });
    const running = host.ctx.chatPipeline.compileFrozenContext(execution, owner);
    const rejected = expect(running).rejects.toThrow('Cancelled');
    await ready; controller.abort(); await rejected;
    expect(stageSignal?.aborted).toBe(true);
    expect(execution.chatHistory).toBe(history);
    expect(execution.compiledCurrentUserMessage).toBeNull();
    expect(execution.executionSnapshot?.executionRoute).toBeNull();
    expect(execution.canonicalContent).toEqual([image('current')]);
  });

  it('keeps unresolved slots while refusing PDF bytes masquerading as an image', async () => {
    const resolved = await host.ctx.chatPipeline.resolveCanonicalImagePayloads([
      image('pdf', invalidHash), image('missing', 'not-a-real-blob'), image('valid'),
    ], () => null);
    expect(resolved).toEqual([null, null, { mimeType: 'image/png', base64: bytes.toString('base64') }]);
  });

  it('ignores malformed persisted canonical arrays instead of executing a partial or unchecked artifact', async () => {
    const execution = await turn('text', []);
    execution.chatHistory = [{ role: 'user', content: 'legacy content', metadata: {
      canonicalContent: [image('old'), { type: 'derived_artifact_ref', artifact_id: 'bad',
        artifact_type: 'ocr_text', content: 'must not be injected', created_at: 42, source_image_ids: null }],
    } }];
    const owner = ports();
    const hydrated: (readonly CanonicalContentPart[])[] = [];
    const resolve = owner.resolveCanonicalImages;
    owner.resolveCanonicalImages = parts => { hydrated.push(parts); return resolve(parts); };
    await host.ctx.chatPipeline.compileFrozenContext(execution, owner);
    expect(hydrated).toEqual([[]]); // Current message only; invalid historical Vec is rejected wholesale.
    expect(execution.chatHistory[0]?.content).toBe('legacy content');
    expect(owner.observeImages).not.toHaveBeenCalled();
  });
});
