import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isAbsolute } from 'node:path';
// boundary-allow cross-plugin-impl: 同 lane（L02）测试宿主组合真实 llm 插件与全局 OCR 熔断器，验证 ocr_extract_text 生产入口
import { createTestHost } from '../../llm/tests/host.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import llm from '../../llm/index.ts';
import { llmReplayPlugin, type ReplayScript } from '../../llm-providers/api.ts';
import translation from '../index.ts';
// boundary-allow cross-plugin-impl: 同 lane（L02）测试宿主组合真实 llm 插件与全局 OCR 熔断器，验证 ocr_extract_text 生产入口
import { makeConfig } from '../../llm/tests/support.ts';
import { image } from '../../../platform/native/image/index.ts';
// boundary-allow cross-plugin-impl: 同 lane（L02）测试宿主组合真实 llm 插件与全局 OCR 熔断器，验证 ocr_extract_text 生产入口
import { OCR_CIRCUIT_BREAKER } from '../../llm/src/ocr_circuit_breaker.ts';
import { ioMessage } from '../../../platform/paths/compat.ts';

const SCRIPTS = {
  ocr: { description: 'OCR answer', rounds: [{ kind: 'sse', frames: [{ content: 'OCR result' }, { finish: 'stop' }], end: 'done' }] },
  rejected: { description: 'provider rejects the key', rounds: [{ kind: 'http-error', status: 401, body: 'rejected' }] },
  held: { description: 'headers sent, then nothing until the client closes', rounds: [{ kind: 'sse', frames: [], end: 'hold' }] },
} satisfies Record<string, ReplayScript>;

async function setup() {
  const root = await mkdtemp('/tmp/opencode/ocr-command-');
  const paths: string[] = [];
  const values = new Map<string, string>();
  const host = await createTestHost({ plugins: [llm, translation, [llmReplayPlugin, { scripts: SCRIPTS }]], provide: {
    settings: { get: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => values.set(key, value),
      getSecret: async () => null, saveSecret: async () => {}, deleteSecret: async () => false },
    secrets: { isEncryptedFormat: () => false, openCrypto: async () => ({ migratePlaintextKey: (value: string) => value }) },
    files: createNodeFiles({ roots: [{ name: 'temp', path: root }] }),
    // F3 has not published its path service yet. These tests supply only its absolute-path/root seam.
    fileManagerPaths: { getTempAppDataDir: () => root,
      resolveImagePath: (path: string) => { if (!isAbsolute(path)) throw new Error('fixture expects absolute inputs'); paths.push(path); return path; } },
  } });
  const replay = host.ctx.llmReplay;
  const live = (script: keyof typeof SCRIPTS) => makeConfig({ id: 'ocr-live', name: 'Paddle', authMode: 'none', enabled: true,
    isMultimodal: true, model: 'PaddlePaddle/PaddleOCR-VL-1.5', baseUrl: replay.baseUrl(script), apiProtocol: 'openai_chat_completions' });
  const config = live('ocr');
  await host.ctx.llm.saveApiConfigurations([config]);
  values.set('ocr.available_models', JSON.stringify([{ configId: config.id, model: config.model, name: 'Paddle', engineType: 'paddle_ocr_vl', enabled: true }]));
  return { host, root, paths, values,
    get bodies() { return replay.requests.map(entry => entry.body as Record<string, unknown>); },
    fail: () => host.ctx.llm.saveApiConfigurations([live('rejected')]),
    hold: () => host.ctx.llm.saveApiConfigurations([live('held')]),
    async close() { await host.dispose(); await rm(root, { recursive: true, force: true }); } };
}
function imageUrl(body: Record<string, unknown>): string {
  return (body.messages as { content: { image_url?: { url: string } }[] }[])[0]!.content[0]!.image_url!.url;
}

describe('ocr_extract_text public command → file OCR → real provider', () => {
  it('decode_payload_infers_png_from_signature and disposes the temporary file', async () => {
    const f = await setup();
    const probe = vi.spyOn(OCR_CIRCUIT_BREAKER, 'allowRequest');
    try {
      expect(await f.host.invoke('ocr_extract_text', { imagePath: '/ignored', imageBase64: 'iVBORw0KGgo=' })).toBe('OCR result');
      expect(imageUrl(f.bodies[0]!)).toBe('data:image/png;base64,iVBORw0KGgo=');
      expect(Buffer.from(imageUrl(f.bodies[0]!).split(',')[1]!, 'base64')).toHaveLength(8);
      expect(f.paths[0]).toMatch(/ocr_temp_[0-9a-f-]{36}\.png$/);
      expect(await readdir(join(f.root, 'temp'))).toEqual([]);
      expect(probe).toHaveBeenCalledTimes(1);
      await f.fail();
      await expect(f.host.invoke('ocr_extract_text', { imageBase64: 'iVBORw0KGgo=' })).rejects.toMatchObject({ error_type: 'LLM' });
      expect(f.host.ctx.llmReplay.requests.map(entry => [entry.scriptId, entry.status])).toEqual([['ocr', 200], ['rejected', 401]]);
      expect(await readdir(join(f.root, 'temp'))).toEqual([]);
    } finally { probe.mockRestore(); await f.close(); }
  });
  it('decode_payload_prefers_data_url_mime_when_signature_is_insufficient and keeps caller files', async () => {
    const f = await setup();
    try {
      expect(await f.host.invoke('ocr_extract_text', { imageBase64: 'data:image/webp;base64,AAECAwQF' })).toBe('OCR result');
      expect(f.paths[0]).toMatch(/\.webp$/);
      expect(imageUrl(f.bodies[0]!)).toBe('data:image/webp;base64,AAECAwQF');
      const path = join(f.root, 'original.png'); await writeFile(path, Buffer.from('iVBORw0KGgo=', 'base64'));
      expect(await f.host.invoke('ocr_extract_text', { imagePath: path })).toBe('OCR result');
      expect((await stat(path)).size).toBe(8);
    } finally { await f.close(); }
  });
  it('validates before OCR, retaining strict base64 diagnostics and directory creation order', async () => {
    const f = await setup();
    try {
      await expect(f.host.invoke('ocr_extract_text')).rejects.toMatchObject({ error_type: 'Validation', message: '必须提供image_path或image_base64' });
      await expect(stat(join(f.root, 'temp'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(f.host.invoke('ocr_extract_text', { imageBase64: '!!!!' })).rejects.toMatchObject({ error_type: 'Validation', message: 'Base64解码失败: Invalid symbol 33, offset 0.' });
      expect(await readdir(join(f.root, 'temp'))).toEqual([]);
      expect(f.bodies).toEqual([]);
    } finally { await f.close(); }
  });
  it('preserves the Rust file-read error context through the registered command', async () => {
    const f = await setup();
    try {
      const path = join(f.root, 'missing.png');
      let ioError: unknown;
      try { await readFile(path); } catch (error) { ioError = error; }
      await expect(f.host.invoke('ocr_extract_text', { imagePath: path })).rejects.toEqual({
        error_type: 'FileSystem', message: `读取试卷图片失败: ${ioMessage(ioError)}`, details: null,
      });
      expect(f.bodies).toEqual([]);
    } finally { await f.close(); }
  });
  it('dedicated OCR excludes generic VLM before file IO and cancels an active provider', async () => {
    const f = await setup();
    try {
      const path = join(f.root, 'file.png'); await writeFile(path, Buffer.from('iVBORw0KGgo=', 'base64'));
      await f.hold();
      const replay = f.host.ctx.llmReplay;
      const started = vi.waitFor(() => { expect(replay.openCount()).toBe(1); });
      const cancellation = new AbortController();
      const pending = f.host.ctx.llmOcrPages.callDedicatedOcrFreeTextWithFallback(path, cancellation.signal);
      await Promise.race([started, pending.then(() => { throw new Error('stalled OCR completed before cancellation'); })]);
      const rejected = expect(pending).rejects.toMatchObject({ error_type: 'LLM', message: 'OCR cancelled' });
      cancellation.abort(); await rejected;
      expect(await replay.whenIdle(5_000)).toBe(true);
      expect(replay.requests.at(-1)).toMatchObject({ scriptId: 'held', end: 'client-closed' });
      expect((await stat(path)).size).toBe(8);
      await f.host.ctx.llm.saveApiConfigurations([makeConfig({ id: 'generic-only', model: 'vision', isMultimodal: true, enabled: true, authMode: 'none' })]);
      f.values.set('ocr.available_models', JSON.stringify([{ configId: 'generic-only', model: 'vision', name: 'Vision', engineType: 'generic_vlm' }]));
      const reads = f.paths.length;
      await expect(f.host.ctx.llmOcrPages.callDedicatedOcrFreeTextWithFallback('/missing', new AbortController().signal))
        .rejects.toMatchObject({ error_type: 'Configuration', message: '没有已启用的 OCR 引擎，请在设置中配置' });
      expect(f.paths).toHaveLength(reads);
    } finally { await f.close(); }
  });
  it('large valid images go through actual F7 Triangle/JPEG85 without upscaling', async () => {
    const f = await setup();
    const resize = vi.spyOn(image, 'resizeTriangleJpeg');
    try {
      // Valid 1x1 PNG with trailing bytes: the Rust image decoder accepts the PNG; size triggers recompression.
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
      const bytes = Buffer.concat([png, Buffer.alloc(1_500_001 - png.length)]);
      const path = join(f.root, 'large.png'); await writeFile(path, bytes);
      expect(await f.host.invoke('ocr_extract_text', { imagePath: path })).toBe('OCR result');
      expect(resize).toHaveBeenCalledTimes(1);
      expect(resize.mock.calls[0]!.slice(1)).toEqual([1600, 1600, 85]);
      expect(Buffer.from(resize.mock.calls[0]![0])).toEqual(bytes);
      const url = imageUrl(f.bodies[0]!); expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
      expect(await image.dimensions(Buffer.from(url.split(',')[1]!, 'base64'))).toEqual({ width: 1, height: 1 });
    } finally { resize.mockRestore(); await f.close(); }
  });
});
