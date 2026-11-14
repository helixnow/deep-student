/** ocr_extract_text without an F3 fileManagerPaths service: active data dir/temp + images/ resolution (file_manager.rs:167/237). */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// boundary-allow cross-plugin-impl: 同 lane（L02）测试宿主组合真实 llm 插件与全局 OCR 熔断器，验证 ocr_extract_text 生产入口
import { createTestHost } from '../../llm/tests/host.ts';
import llm from '../../llm/index.ts';
import translation from '../index.ts';
// boundary-allow cross-plugin-impl: 同 lane（L02）测试宿主组合真实 llm 插件与全局 OCR 熔断器，验证 ocr_extract_text 生产入口
import { makeConfig } from '../../llm/tests/support.ts';
// boundary-allow cross-plugin-impl: 同 lane（L02）测试宿主组合真实 llm 插件与全局 OCR 熔断器，验证 ocr_extract_text 生产入口
import { OCR_CIRCUIT_BREAKER } from '../../llm/src/ocr_circuit_breaker.ts';
import { writableAppDataDir } from '../src/ocr_extract.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';

const files = createNodeFiles({ roots: [{ name: 'temp', path: tmpdir() }] });

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; OCR_CIRCUIT_BREAKER.recordSuccess(); });

describe('ocr_extract_text default FileManager paths', () => {
  it('writes the base64 temp file under <dataDir>/temp, OCRs it through llmFileOcr and removes it', async () => {
    const values = new Map<string, string>();
    const host = await createTestHost({ plugins: [llm, translation], provide: {
      settings: { get: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => values.set(key, value),
        getSecret: async () => null, saveSecret: async () => {}, deleteSecret: async () => false },
      secrets: { isEncryptedFormat: () => false, openCrypto: async () => ({ migratePlaintextKey: (value: string) => value }) },
    } });
    try {
      const config = makeConfig({ id: 'paddle', name: 'Paddle', authMode: 'none', enabled: true, isMultimodal: true,
        model: 'PaddlePaddle/PaddleOCR-VL-1.5', baseUrl: 'https://paddle.example/v1', apiProtocol: 'openai_chat_completions' });
      await host.ctx.llm.saveApiConfigurations([config]);
      values.set('ocr.available_models', JSON.stringify([{ configId: 'paddle', model: config.model, name: 'Paddle', engineType: 'paddle_ocr_vl' }]));
      const urls: string[] = [];
      let tempFiles: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        urls.push(String(input));
        tempFiles = readdirSync(join(host.ctx.app.dataDir, 'temp'));
        const body = JSON.parse(String(init?.body)) as { messages: { content: { image_url?: { url: string } }[] }[] };
        expect(body.messages[0]!.content[0]!.image_url!.url).toBe('data:image/png;base64,iVBORw0KGgo=');
        return new Response('data: {"choices":[{"delta":{"content":"识别结果"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch;
      expect(await host.invoke('ocr_extract_text', { imageBase64: 'iVBORw0KGgo=' })).toBe('识别结果');
      expect(urls).toEqual(['https://paddle.example/v1/chat/completions']);
      expect(tempFiles).toHaveLength(1);
      expect(tempFiles[0]).toMatch(/^ocr_temp_[0-9a-f-]{36}\.png$/);
      expect(readdirSync(join(host.ctx.app.dataDir, 'temp'))).toEqual([]);
    } finally { await host.dispose(); }
  });

  it('get_writable_app_data_dir falls back to data_dir/DeepStudent when the primary is not writable', async () => {
    const errors: string[] = [];
    const root = mkdtempSync(join(tmpdir(), 'l02-writable-'));
    // A path below a regular file cannot be created (ENOTDIR), like an unwritable primary dir.
    writeFileSync(join(root, 'file'), 'x');
    const primary = join(root, 'file', 'data');
    const chosen = await writableAppDataDir(files, primary, root, { error: m => errors.push(m), warn: () => undefined }, 'linux', tmpdir());
    expect(chosen).toBe(join(root, 'DeepStudent'));
    expect(existsSync(chosen)).toBe(true);
    expect(existsSync(join(chosen, '.write_test'))).toBe(false);
    expect(errors).toEqual([`⚠️ [文件系统] 创建目录失败 ${primary}: Not a directory (os error 20)`]);
    rmSync(root, { recursive: true, force: true });
  });

  it('get_writable_app_data_dir keeps the host error text when the platform is not posix', async () => {
    const errors: string[] = [];
    const root = mkdtempSync(join(tmpdir(), 'l02-writable-'));
    writeFileSync(join(root, 'file'), 'x');
    const primary = join(root, 'file', 'data');
    await writableAppDataDir(files, primary, root, { error: m => errors.push(m), warn: () => undefined }, 'win32', tmpdir());
    expect(errors).toHaveLength(1);
    expect(errors[0]!.startsWith(`⚠️ [文件系统] 创建目录失败 ${primary}: ENOTDIR`)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
