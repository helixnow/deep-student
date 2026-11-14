import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createPipelineHost } from './chat-host.ts';
import type { ContextCompilerLlmCalls, RuntimeImage } from '../api.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
beforeAll(async () => {
  host = await createPipelineHost({ llm: true });
  await host.ctx.llm.saveApiConfigurations([{ id: 'text', name: 'text', model: 'text-model',
    baseUrl: 'https://provider.invalid/v1', apiKey: 'test-key', enabled: true,
    isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false }]);
}, 60_000);
afterAll(async () => { await host?.dispose(); });

const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function image(base64 = bytes.toString('base64')): RuntimeImage {
  return { messageIndex: 0, imageIndex: 0, turnIndex: 0, isCurrentTurn: true, imageId: 'image',
    mimeType: 'image/png', base64, pinned: false, retrievalHit: false };
}
function externalOwner(): ContextCompilerLlmCalls {
  return {
    callRawPromptWithConfigIdAndImagesCancellable: vi.fn(async () => {
      throw new Error('unexpected auxiliary operation');
    }),
    callDedicatedOcrFreeTextWithFallback: vi.fn(async () => { throw new Error('unexpected OCR operation'); }),
  };
}
const bind = (owner: ContextCompilerLlmCalls) => host.ctx.chatPipeline.bindContextCompilationPorts(owner, () => null);

// These are caller-side lifetime/argument tests. The supplied L02 high-level owner is scripted,
// not a substitute for L02's pending real implementation or full send acceptance.
describe('P1 context compiler high-level owner binding', () => {
  it('passes exact raw-image caller/config/prompt/payload/signal and consumes assistant_message', async () => {
    const owner = externalOwner(); const signal = new AbortController().signal;
    owner.callRawPromptWithConfigIdAndImagesCancellable = vi.fn(async () => ({
      assistant_message: 'observed', raw_response: 'raw', chain_of_thought_details: null, cancelled: false,
    }));
    const images = [{ mime: 'image/png', base64: bytes.toString('base64') }];
    expect(await bind(owner).observeImages('frozen-config', 'exact prompt', images, signal)).toBe('observed');
    expect(owner.callRawPromptWithConfigIdAndImagesCancellable).toHaveBeenCalledExactlyOnceWith(
      'frozen-config', 'exact prompt', images, 'chat_v2', signal);
  });

  it('writes decoded bytes with the Rust suffix, keeps the file through OCR, then removes it', async () => {
    const owner = externalOwner(); const signal = new AbortController().signal;
    let observedPath = ''; let receivedSignal: AbortSignal | undefined; let observedBytes: Buffer | undefined;
    owner.callDedicatedOcrFreeTextWithFallback = async (file, cancellation) => {
      observedPath = file; receivedSignal = cancellation; observedBytes = await readFile(file);
      return 'recognized';
    };
    expect(await bind(owner).ocrImage(image(), signal)).toBe('recognized');
    expect(receivedSignal).toBe(signal);
    expect(path.basename(observedPath)).toMatch(/^chat-v2-ocr-.*\.png$/);
    expect(observedBytes).toEqual(bytes);
    await expect(stat(observedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.dirname(observedPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves owner failure and removes the temporary file on rejection', async () => {
    const owner = externalOwner(); const error = new Error('dedicated OCR rejected the image');
    let file = '';
    owner.callDedicatedOcrFreeTextWithFallback = async value => { file = value; throw error; };
    await expect(bind(owner).ocrImage({ ...image(), mimeType: 'image/other' }, new AbortController().signal)).rejects.toBe(error);
    expect(path.extname(file)).toBe('.jpg');
    await expect(stat(path.dirname(file))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects noncanonical base64 before invoking OCR with the original Rust error prefix', async () => {
    const owner = externalOwner();
    await expect(bind(owner).ocrImage(image('%%%'), new AbortController().signal))
      .rejects.toThrow('invalid image base64: Invalid symbol 37, offset 0.');
    expect(owner.callDedicatedOcrFreeTextWithFallback).not.toHaveBeenCalled();
  });

  it('compiler cancellation waits for temporary-file cleanup even when the remote owner never settles', async () => {
    const execution = host.ctx.chatPipeline.createPipelineContext({ sessionId: 'cancel-ocr', content: 'read image',
      options: { modelId: 'text' } });
    await host.ctx.chatPipeline.freezeExecutionContext(execution, () => []);
    execution.executionSnapshot!.generationPlan.auxiliaryMultimodalConfigId = null;
    execution.executionSnapshot!.capabilitySnapshot.ocr = { configured: true, healthy: true,
      circuitOpen: false, protocolCompatible: true, indexCompatible: true };
    execution.chatHistory = [{ role: 'user', content: 'old image', image_base64: [bytes.toString('base64')] }];
    const cancel = new AbortController(); execution.setCancellationToken(cancel.signal);
    const owner = externalOwner();
    let file = ''; let stageSignal: AbortSignal | undefined; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    owner.callDedicatedOcrFreeTextWithFallback = (value, signal) => {
      file = value; stageSignal = signal; started(); return new Promise<string>(() => {});
    };
    const compiled = host.ctx.chatPipeline.compileFrozenContext(execution, bind(owner));
    const failure = expect(compiled).rejects.toThrow('Cancelled');
    await ready;
    expect(await readFile(file)).toEqual(bytes);
    cancel.abort(); await failure;
    expect(stageSignal?.aborted).toBe(true);
    await expect(stat(path.dirname(file))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(execution.compiledCurrentUserMessage).toBeNull();
  });
});
