/**
 * `src/cmd/handout.rs:74-127` handout_llm_complete / handout_vlm_caption and
 * `vlm_grounding_service.rs:1364-1494` get_vlm_config (no Rust tests): production-entry
 * contract tests through `host.invoke`. Only the L02 model services are substituted.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';

type Cfg = { id: string; name: string; model: string; baseUrl: string; enabled: boolean; isMultimodal: boolean };
type OcrCfg = { config_id: string; model: string; engine_type: string; name: string; is_free: boolean;
  enabled: boolean; priority: number };
type Call = { method: string; args: unknown[] };

let host: TestHost;
let configs: Cfg[];
let configsFail = false;
let ocrModels: OcrCfg[];
let calls: Call[];
let respond: (method: string) => Promise<unknown>;

function cfg(id: string, model: string, extra: Partial<Cfg> = {}): Cfg {
  return { id, name: `n-${id}`, model, baseUrl: 'https://api.example.com', enabled: true, isMultimodal: true, ...extra };
}
function ocr(configId: string, engine: string, priority: number, enabled = true): OcrCfg {
  return { config_id: configId, model: 'm', engine_type: engine, name: 'o', is_free: false, enabled, priority };
}
const ok = (text: string) => Promise.resolve({ assistant_message: text, raw_response: null,
  chain_of_thought_details: null, cancelled: false });

async function failure(command: string, args: Record<string, unknown>): Promise<unknown> {
  return host.invoke(command, args).then(() => null, (error: unknown) => error);
}
/** host.invoke rejects with the CommandError's wire value (the Rust AppError). */
function appError(error: unknown): unknown {
  expect(error).not.toBeNull();
  return error;
}

beforeEach(async () => {
  configs = [];
  configsFail = false;
  ocrModels = [];
  calls = [];
  respond = () => ok('done');
  const rawPrompt = {
    callModel2RawPromptOpts: (...args: unknown[]) => {
      calls.push({ method: 'callModel2RawPromptOpts', args }); return respond('callModel2RawPromptOpts');
    },
    callRawPromptWithConfigIdAndImages: (...args: unknown[]) => {
      calls.push({ method: 'callRawPromptWithConfigIdAndImages', args });
      return respond('callRawPromptWithConfigIdAndImages');
    },
  };
  host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: { get: () => null, save: () => undefined },
      paths: { appDataDir: '/nonexistent' },
      llm: { getApiConfigs: async () => {
        if (configsFail) throw { error_type: 'Database', message: 'boom' };
        return configs;
      } },
      llmOcrModels: { getAvailableOcrModels: async () => ocrModels },
      llmRawPrompt: rawPrompt,
    },
  });
});

afterEach(async () => {
  await host.dispose();
});

it('handout_llm_complete calls model2 raw prompt with media_handout caller and task (handout.rs:74-94)', async () => {
  respond = () => ok('大纲');
  expect(await host.invoke('handout_llm_complete', { prompt: 'write' })).toBe('大纲');
  await host.invoke('handout_llm_complete', { prompt: 'json please', jsonMode: true, requestId: 'r0' });
  expect(calls).toEqual([
    { method: 'callModel2RawPromptOpts', args: ['write', false, { other: 'media_handout' }, 'media_handout'] },
    { method: 'callModel2RawPromptOpts', args: ['json please', true, { other: 'media_handout' }, 'media_handout'] },
  ]);
});

it('check_prompt rejects empty and over-long prompts before any model call', async () => {
  expect(appError(await failure('handout_llm_complete', { prompt: ' \n\t' })))
    .toEqual({ error_type: 'Validation', message: 'prompt is empty', details: null });
  expect(appError(await failure('handout_vlm_caption', { prompt: 'x'.repeat(120_001), imageBase64: 'AA==' })))
    .toEqual({ error_type: 'Validation', message: 'prompt too long', details: null });
  // 120_000 chars counted as Unicode scalar values, not UTF-16 units
  expect(await host.invoke('handout_llm_complete', { prompt: '😀'.repeat(120_000) })).toBe('done');
  expect(calls).toHaveLength(1);
});

it('run_cancellable: output.cancelled, pre-cancelled token and in-flight cancel all map to Validation "cancelled"', async () => {
  const cancelled = { error_type: 'Validation', message: 'cancelled', details: null };
  respond = () => Promise.resolve({ assistant_message: 'x', raw_response: null, chain_of_thought_details: null, cancelled: true });
  expect(appError(await failure('handout_llm_complete', { prompt: 'p' }))).toEqual(cancelled);

  await host.invoke('handout_cancel', { requestId: 'pre' });
  calls = [];
  expect(appError(await failure('handout_llm_complete', { prompt: 'p', requestId: 'pre' }))).toEqual(cancelled);
  expect(calls).toEqual([]);

  let reject!: (error: unknown) => void;
  respond = () => new Promise((_resolve, rej) => { reject = rej; });
  const pending = failure('handout_llm_complete', { prompt: 'p', requestId: 'live' });
  await new Promise(resolve => setTimeout(resolve, 10));
  await host.invoke('handout_cancel', { requestId: 'live' });
  expect(appError(await pending)).toEqual(cancelled);
  reject({ error_type: 'LLM', message: 'late failure after drop' }); // dropped future: no unhandled rejection
  await host.invoke('handout_release', { requestId: 'live' });
  respond = () => ok('again');
  expect(await host.invoke('handout_llm_complete', { prompt: 'p', requestId: 'live' })).toBe('again');
});

it('L02 AppError values propagate unchanged', async () => {
  respond = () => Promise.reject({ error_type: 'LLM', message: 'HTTP 400' });
  expect(appError(await failure('handout_llm_complete', { prompt: 'p' })))
    .toEqual({ error_type: 'LLM', message: 'HTTP 400', details: null });
});

it('handout_vlm_caption validates the frame, defaults mime and uses the VLM config id (handout.rs:96-127)', async () => {
  configs = [cfg('text', 'gpt-4o-mini', { isMultimodal: false }), cfg('qwen', 'Qwen2.5-VL-72B')];
  for (const imageBase64 of ['', 'A'.repeat(8 * 1024 * 1024 + 1)]) {
    expect(appError(await failure('handout_vlm_caption', { prompt: 'p', imageBase64 })))
      .toEqual({ error_type: 'Validation', message: 'invalid frame image', details: null });
  }
  expect(calls).toEqual([]);
  respond = () => ok('一张图');
  expect(await host.invoke('handout_vlm_caption', { prompt: 'cap', imageBase64: 'QUJD' })).toBe('一张图');
  await host.invoke('handout_vlm_caption', { prompt: 'cap', imageBase64: 'QUJD', mime: 'image/png' });
  expect(calls).toEqual([
    { method: 'callRawPromptWithConfigIdAndImages',
      args: ['qwen', 'cap', [{ mime: 'image/jpeg', base64: 'QUJD' }], { other: 'media_handout_vlm' }] },
    { method: 'callRawPromptWithConfigIdAndImages',
      args: ['qwen', 'cap', [{ mime: 'image/png', base64: 'QUJD' }], { other: 'media_handout_vlm' }] },
  ]);
});

it('get_vlm_config: no candidate is a Configuration error, raised even for a cancelled request', async () => {
  configs = [cfg('text', 'deepseek-chat', { isMultimodal: false }), cfg('off', 'qwen3-vl-plus', { enabled: false })];
  await host.invoke('handout_cancel', { requestId: 'c' });
  expect(appError(await failure('handout_vlm_caption', { prompt: 'p', imageBase64: 'QQ==', requestId: 'c' }))).toEqual({
    error_type: 'Configuration',
    message: '未找到可用的 VLM 模型（需要 GLM-4.6V / Qwen-VL 等多模态模型），请在设置中配置',
    details: null,
  });
});

async function chosen(): Promise<unknown> {
  calls = [];
  await host.invoke('handout_vlm_caption', { prompt: 'p', imageBase64: 'QQ==' });
  return calls[0]!.args[0];
}

it('get_vlm_config_candidates tier order (vlm_grounding_service.rs:1402-1471)', async () => {
  configs = [
    cfg('any', 'gpt-4o'),
    cfg('qwenvl', 'qwen-vl-max'),
    cfg('q25', 'qwen2.5-vl-7b'),
    cfg('q3', 'Qwen3-VL-235B'),
    cfg('g45', 'GLM-4.5V'),
    cfg('g45t', 'glm-4.5v-thinking'),
    cfg('g46', 'zai-org/GLM-4.6V', { baseUrl: 'https://api.SiliconFlow.cn' }), // discontinued
    cfg('g41', 'glm-4.1v-thinking-flash'), // blacklisted
    cfg('g5', 'glm-5v'),
  ];
  expect(await chosen()).toBe('g5'); // Tier 1 GLM-5.xV
  configs = configs.filter(c => c.id !== 'g5');
  expect(await chosen()).toBe('g45'); // Tier 2, thinking variant skipped
  configs = configs.filter(c => c.id !== 'g45');
  expect(await chosen()).toBe('q3');
  configs = configs.filter(c => c.id !== 'q3');
  expect(await chosen()).toBe('q25');
  configs = configs.filter(c => c.id !== 'q25');
  expect(await chosen()).toBe('qwenvl');
  configs = configs.filter(c => c.id !== 'qwenvl');
  // Tier 7: first remaining multimodal in list order (g45t is not blacklisted, but 'any' comes first)
  expect(await chosen()).toBe('any');

  // Tier 0: enabled glm4v_ocr engines by priority beat name matching; blacklist still applies.
  configs = [cfg('q3', 'qwen3-vl'), cfg('ocrA', 'some-vision'), cfg('ocrB', 'other-vision'), cfg('bad', 'GLM-4V-Plus')];
  ocrModels = [ocr('bad', 'glm4v_ocr', 0), ocr('ocrA', 'glm4v_ocr', 5), ocr('ocrB', 'glm4v_ocr', 2), ocr('q3', 'glm4v_ocr', 1, false)];
  expect(await chosen()).toBe('ocrB');
  // Tier 6 (generic_vlm / paddle_ocr_vl*) ranks after name matches but before any-multimodal.
  configs = [cfg('plain', 'gpt-4o'), cfg('pv', 'paddle-vision')];
  ocrModels = [ocr('pv', 'paddle_ocr_vl_v1', 3)];
  expect(await chosen()).toBe('pv');
  configs = [cfg('plain', 'gpt-4o'), cfg('pv', 'paddle-vision'), cfg('qv', 'qwen-vl-plus')];
  expect(await chosen()).toBe('qv');
});

it('get_api_configs failures degrade to no candidates (unwrap_or_default)', async () => {
  configs = [cfg('q3', 'qwen3-vl')];
  configsFail = true;
  const error = await failure('handout_vlm_caption', { prompt: 'p', imageBase64: 'QQ==' });
  expect((appError(error) as { error_type: string }).error_type).toBe('Configuration');
  expect(calls).toEqual([]);
});
