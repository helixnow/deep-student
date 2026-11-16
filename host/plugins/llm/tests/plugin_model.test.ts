/** `pluginModel`: the narrow model entry for community / workshop plugins (docs/plugins/SDK.md §3.5). */
import { describe, expect, it, vi } from 'vitest';
import type { StandardModel2Output } from '../api.ts';
import {
  PLUGIN_MODEL_MAX_CONCURRENT, PLUGIN_MODEL_MAX_IMAGES, PLUGIN_MODEL_MAX_PROMPT_CHARS, PLUGIN_MODEL_MAX_SYSTEM_CHARS, createPluginModelService,
} from '../src/plugin_model.ts';

const output = (text: string, cancelled = false): StandardModel2Output =>
  ({ assistant_message: text, raw_response: null, chain_of_thought_details: null, cancelled });

describe('pluginModel.complete', () => {
  it('sends one raw prompt to the user\'s dialogue model as a plugin utility call and returns only the text', async () => {
    const callModel2RawPromptOpts = vi.fn().mockResolvedValue(output('特征向量不为零'));
    const service = createPluginModelService({ rawPrompt: { callModel2RawPromptOpts } });
    await expect(service.complete({ system: ' 编成口诀 ', prompt: ' 特征向量的定义 ' })).resolves.toEqual({ text: '特征向量不为零' });
    expect(callModel2RawPromptOpts).toHaveBeenCalledWith('编成口诀\n\n特征向量的定义', false, { other: 'plugin' }, 'utility', expect.any(AbortSignal));
    await service.complete({ prompt: '只有正文' });
    expect(callModel2RawPromptOpts).toHaveBeenLastCalledWith('只有正文', false, { other: 'plugin' }, 'utility', expect.any(AbortSignal));
    expect(Object.keys(service)).toEqual(['complete', 'stream']);
  });

  it('refuses malformed and oversized requests before any model call', async () => {
    const callModel2RawPromptOpts = vi.fn();
    const service = createPluginModelService({ rawPrompt: { callModel2RawPromptOpts } });
    await expect(service.complete({ prompt: '   ' })).rejects.toThrow('PLUGIN_MODEL_INVALID: prompt must be a non-empty string');
    await expect(service.complete({ prompt: 42 as unknown as string })).rejects.toThrow('PLUGIN_MODEL_INVALID');
    await expect(service.complete({ prompt: 'x', system: 1 as unknown as string })).rejects.toThrow('PLUGIN_MODEL_INVALID: system must be a string');
    await expect(service.complete({ prompt: 'x'.repeat(PLUGIN_MODEL_MAX_PROMPT_CHARS + 1) })).rejects.toThrow(`prompt exceeds ${PLUGIN_MODEL_MAX_PROMPT_CHARS}`);
    await expect(service.complete({ prompt: 'x', system: 'y'.repeat(PLUGIN_MODEL_MAX_SYSTEM_CHARS + 1) })).rejects.toThrow(`system exceeds ${PLUGIN_MODEL_MAX_SYSTEM_CHARS}`);
    expect(callModel2RawPromptOpts).not.toHaveBeenCalled();
  });

  it('surfaces provider failures with their message, whatever shape the llm layer throws', async () => {
    const failing = (error: unknown) => createPluginModelService({ rawPrompt: { callModel2RawPromptOpts: vi.fn().mockRejectedValue(error) } });
    await expect(failing(new Error('未配置对话模型')).complete({ prompt: 'x' })).rejects.toThrow('PLUGIN_MODEL_FAILED: 未配置对话模型');
    await expect(failing({ value: { error_type: 'Network', message: 'HTTP 401' } }).complete({ prompt: 'x' })).rejects.toThrow('PLUGIN_MODEL_FAILED: HTTP 401');
    await expect(failing({ error_type: 'Configuration', message: 'no api key' }).complete({ prompt: 'x' })).rejects.toThrow('PLUGIN_MODEL_FAILED: no api key');
    await expect(failing('boom').complete({ prompt: 'x' })).rejects.toThrow('PLUGIN_MODEL_FAILED: boom');
  });

  it('passes cancellation through and reports it as cancelled', async () => {
    const controller = new AbortController();
    const callModel2RawPromptOpts = vi.fn((_p: string, _j: boolean, _c: unknown, _t: string, signal?: AbortSignal) =>
      new Promise<StandardModel2Output>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason))));
    const service = createPluginModelService({ rawPrompt: { callModel2RawPromptOpts } });
    const pending = service.complete({ prompt: 'x' }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('PLUGIN_MODEL_CANCELLED');
    await expect(service.complete({ prompt: 'x' }, { signal: controller.signal })).rejects.toThrow('PLUGIN_MODEL_CANCELLED');
    expect(callModel2RawPromptOpts).toHaveBeenCalledTimes(1);
    const cancelled = createPluginModelService({ rawPrompt: { callModel2RawPromptOpts: vi.fn().mockResolvedValue(output('', true)) } });
    await expect(cancelled.complete({ prompt: 'x' })).rejects.toThrow('PLUGIN_MODEL_CANCELLED');
  });

  it('times out and bounds the calls in flight, releasing the slot afterwards', async () => {
    const hang = vi.fn((_p: string, _j: boolean, _c: unknown, _t: string, signal?: AbortSignal) =>
      new Promise<StandardModel2Output>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason))));
    const slow = createPluginModelService({ rawPrompt: { callModel2RawPromptOpts: hang }, timeoutMs: 20 });
    await expect(slow.complete({ prompt: 'x' })).rejects.toThrow('PLUGIN_MODEL_FAILED: the model did not answer in time');

    const release: ((value: StandardModel2Output) => void)[] = [];
    const queued = vi.fn(() => new Promise<StandardModel2Output>(resolve => { release.push(resolve); }));
    const service = createPluginModelService({ rawPrompt: { callModel2RawPromptOpts: queued } });
    const running = Array.from({ length: PLUGIN_MODEL_MAX_CONCURRENT }, () => service.complete({ prompt: 'x' }));
    await expect(service.complete({ prompt: 'x' })).rejects.toThrow('PLUGIN_MODEL_BUSY');
    release.forEach(resolve => resolve(output('done')));
    await expect(Promise.all(running)).resolves.toEqual(Array(PLUGIN_MODEL_MAX_CONCURRENT).fill({ text: 'done' }));
    const next = service.complete({ prompt: 'x' });
    release.at(-1)!(output('again'));
    await expect(next).resolves.toEqual({ text: 'again' });
  });
});

describe('pluginModel images and streaming', () => {
  it('sends attached images to the dialogue model and validates them first', async () => {
    const callModel2RawPrompt = vi.fn().mockResolvedValue(output('一张函数图像'));
    const callModel2RawPromptOpts = vi.fn();
    const service = createPluginModelService({ rawPrompt: { callModel2RawPromptOpts, callModel2RawPrompt } });
    await expect(service.complete({ prompt: '这是什么', images: [{ mime: 'image/png', base64: 'data:image/png;base64,AAAA' }] }))
      .resolves.toEqual({ text: '一张函数图像' });
    expect(callModel2RawPrompt).toHaveBeenCalledWith('这是什么', [{ mime: 'image/png', base64: 'AAAA' }], { other: 'plugin' });
    expect(callModel2RawPromptOpts).not.toHaveBeenCalled();
    await expect(service.complete({ prompt: 'x', images: [{ mime: 'text/plain', base64: 'AA' }] })).rejects.toThrow('PLUGIN_MODEL_INVALID: images[0]');
    await expect(service.complete({ prompt: 'x', images: Array(PLUGIN_MODEL_MAX_IMAGES + 1).fill({ mime: 'image/png', base64: 'A' }) }))
      .rejects.toThrow('PLUGIN_MODEL_INVALID: at most');
  });

  it('streams content chunks to onText and resolves with the whole answer', async () => {
    const hooks = new Map<string, { onContentChunk?(text: string): void }>();
    const callUnifiedModel2Stream = vi.fn(async (input: { streamEvent: string; taskContext: string | null; systemPromptOverride?: string | null }) => {
      for (const piece of ['特征', '向量']) hooks.get(input.streamEvent)!.onContentChunk!(piece);
      return output('特征向量');
    });
    const events = {
      registerStreamHooks: vi.fn((name: string, h: { onContentChunk?(text: string): void }) => { hooks.set(name, h); }),
      unregisterStreamHooksIfOwner: vi.fn((name: string) => hooks.delete(name)),
    };
    const service = createPluginModelService({
      rawPrompt: { callModel2RawPromptOpts: vi.fn() },
      streaming: { model2: { callUnifiedModel2Stream } as never, events, cancel: vi.fn(async () => {}) },
    });
    const pieces: string[] = [];
    await expect(service.stream({ prompt: '定义', system: '简短' }, { onText: (piece) => pieces.push(piece) })).resolves.toEqual({ text: '特征向量' });
    expect(pieces).toEqual(['特征', '向量']);
    expect(callUnifiedModel2Stream.mock.calls[0]![0]).toMatchObject({ taskContext: 'plugin', systemPromptOverride: '简短', disableTools: true });
    expect(hooks.size).toBe(0);
  });

  it('cancels a stream through the llm manager when the caller aborts', async () => {
    const cancel = vi.fn(async () => {});
    let finish!: (value: StandardModel2Output) => void;
    const service = createPluginModelService({
      rawPrompt: { callModel2RawPromptOpts: vi.fn() },
      streaming: {
        model2: { callUnifiedModel2Stream: () => new Promise<StandardModel2Output>((resolve) => { finish = resolve; }) } as never,
        events: { registerStreamHooks: vi.fn(), unregisterStreamHooksIfOwner: vi.fn() }, cancel,
      },
    });
    const controller = new AbortController();
    const pending = service.stream({ prompt: 'x' }, { signal: controller.signal });
    controller.abort();
    expect(cancel).toHaveBeenCalledOnce();
    finish(output('', true));
    await expect(pending).rejects.toThrow('PLUGIN_MODEL_CANCELLED');
  });

  it('delivers the whole answer as one piece without a streaming backend', async () => {
    const service = createPluginModelService({ rawPrompt: { callModel2RawPromptOpts: vi.fn().mockResolvedValue(output('整段')) } });
    const pieces: string[] = [];
    await expect(service.stream({ prompt: 'x' }, { onText: (piece) => pieces.push(piece) })).resolves.toEqual({ text: '整段' });
    expect(pieces).toEqual(['整段']);
  });
});
