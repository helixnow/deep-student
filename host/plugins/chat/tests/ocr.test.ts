import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { vfsStub } from './database-fixture.ts';
import { GenericVlmAdapter, SystemOcrAdapter, setSystemOcrBinding } from '../../llm-providers/api.ts';
import { ChatV2Error } from '../api.ts';
import type { OcrManager } from '../src/ocr.ts';

describe('chat_v2_perform_ocr', () => {
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let native: boolean;
  let rawFailure: Error | null;
  let calls: unknown[][];
  beforeEach(async () => {
    native = false; rawFailure = null; calls = [];
    const llm: OcrManager = {
      async getOcrAdapter() { calls.push(['adapter']); return native ? new SystemOcrAdapter() : new GenericVlmAdapter(); },
      async callOcrModelRawPrompt(prompt, images) {
        calls.push(['cloud', prompt, images]);
        if (rawFailure) throw rawFailure;
        return { assistantMessage: '\u0085 result 中文 \n' };
      },
    };
    // This Rust handler never opens a database; unexpected DB access must fail.
    host = await createTestHost({ plugins: [plugin], provide: { storage: {}, vfs: vfsStub, llm } });
  });
  afterEach(async () => { setSystemOcrBinding(null); await host.dispose(); });

  it('validates empty images before resolving the adapter', async () => {
    await expect(host.invoke('chat_v2_perform_ocr', { request: { images: [] } }))
      .rejects.toBe(new ChatV2Error('Validation', 'At least one image is required').toCommandError());
    expect(calls).toEqual([]);
  });
  it('normalizes base64, preserves MIME prefix behavior and trims only the cloud result', async () => {
    expect(await host.invoke('chat_v2_perform_ocr', { request: { images: [
      'data:image/png;base64,aGk=,ignored', 'data:image/webp;base64,AA==', 'data:image/svg+xml;base64,YQ==',
    ] } })).toEqual({ ocr_text: 'result 中文', tags: [], mistake_type: '' });
    expect(calls).toEqual([['adapter'], ['cloud', new GenericVlmAdapter().buildPrompt('free_ocr'), [
      { mime: 'image/png', base64: 'aGk=' }, { mime: 'image/webp', base64: 'AA==' }, { mime: 'image/jpeg', base64: 'YQ==' },
    ]]]);
  });
  it('preserves base64 crate errors and image indices without calling the cloud', async () => {
    for (const [input, error] of [['data:bad', 'Invalid data URL format'], ['YQ', 'Base64 decode error: Invalid padding'],
      ['YR==', 'Base64 decode error: Invalid last symbol 82, offset 1.']]) {
      await expect(host.invoke('chat_v2_perform_ocr', { request: { images: ['YQ==', input] } }))
        .rejects.toBe(new ChatV2Error('Validation', `Failed to parse image 1: ${error}`).toCommandError());
    }
    expect(calls).toEqual([['adapter'], ['adapter'], ['adapter']]);
  });
  // system_ocr/mod.rs:49-68 only dispatches native bindings on macOS/Windows.
  it.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')('native OCR runs sequentially and joins only nonempty results without trimming', async () => {
    native = true;
    const bytes: number[][] = [];
    const results = ['', ' first ', '', 'second'];
    setSystemOcrBinding({ async performSystemOcr(image) { bytes.push([...image]); return results.shift()!; } });
    expect(await host.invoke('chat_v2_perform_ocr', { request: { images: ['AA==', 'AQ==', 'Ag==', 'Aw=='] } }))
      .toEqual({ ocr_text: ' first \n\nsecond', tags: [], mistake_type: '' });
    expect(bytes).toEqual([[0], [1], [2], [3]]);
    expect(calls).toEqual([['adapter']]);
  });
  it('logs and returns the full cloud error context', async () => {
    rawFailure = new Error('model rejected image');
    const errors: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 3 }, export(message) {
      if (message.type === 'error') errors.push(String(message.args[0]));
    } });
    await expect(host.invoke('chat_v2_perform_ocr', { request: { images: ['AA=='] } }))
      .rejects.toBe(new ChatV2Error('Llm', 'OCR failed: model rejected image').toCommandError());
    expect(errors).toContain('[ChatV2::OCR] OCR failed: model rejected image');
  });
  it.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')('retains native OcrError Display and stops before later images', async () => {
    native = true;
    let visited = 0;
    setSystemOcrBinding({ async performSystemOcr() {
      visited++;
      throw new Error('Vision failed');
    } });
    const errors: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 3 }, export(message) {
      if (message.type === 'error') errors.push(String(message.args[0]));
    } });
    await expect(host.invoke('chat_v2_perform_ocr', { request: { images: ['AA==', 'AQ=='] } }))
      .rejects.toBe(new ChatV2Error('Llm', 'System OCR failed: 图片处理错误: OCR task failed: Vision failed').toCommandError());
    expect(visited).toBe(1);
    expect(errors).toContain('[ChatV2::OCR] System OCR failed for image 0: 图片处理错误: OCR task failed: Vision failed');
  });
  it.skipIf(process.platform === 'darwin' || process.platform === 'win32')('unsupported platform preserves native OCR error and stops before later images', async () => {
    native = true;
    let visited = 0;
    setSystemOcrBinding({ async performSystemOcr() { visited++; return 'unexpected native dispatch'; } });
    const errors: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 3 }, export(message) {
      if (message.type === 'error') errors.push(String(message.args[0]));
    } });
    const display = '不支持的功能: System OCR is not available on this platform. Supported: macOS 10.15+, Windows 10+. Please use a VLM-based OCR engine instead.';
    await expect(host.invoke('chat_v2_perform_ocr', { request: { images: ['AA==', 'invalid base64'] } }))
      .rejects.toBe(new ChatV2Error('Llm', `System OCR failed: ${display}`).toCommandError());
    expect(visited).toBe(0);
    expect(calls).toEqual([['adapter']]);
    expect(errors).toEqual([`[ChatV2::OCR] System OCR failed for image 0: ${display}`]);
  });
});
