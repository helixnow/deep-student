// @vitest-environment node
/**
 * example.translation-prompt：声明 service:translation 权限并注入官方翻译服务（测试宿主提供替身）。
 * 覆盖：装载与配置、贡献（服务）、转发时换提示词、权限未声明被拒绝、translation 缺席时不启动、卸载、没有 UI 半。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TranslationRequest, TranslationResponse, TranslationService } from '../../../../host/plugins/translation/api.ts';
import { examplePath, loadExample } from '../../../testing/harness';
import { DEFAULT_PROMPT } from '../index';

const ID = 'example.translation-prompt';
const dir = (...segments: string[]) => examplePath('translation-prompt', ...segments);
const fixture = (name: string) => dir('__tests__', 'fixtures', name);

const request: TranslationRequest = { text: 'myocardial infarction', src_lang: 'en', tgt_lang: 'zh', session_id: 's1', prompt_override: 'ignored', domain: 'medicine' };

/** 官方 translation 服务的替身：原样记录每次转发的全部参数。 */
function fakeTranslation() {
  const calls: Parameters<TranslationService['translateTextStream']>[] = [];
  const translation: Pick<TranslationService, 'translateTextStream'> = {
    async translateTextStream(...args): Promise<TranslationResponse> {
      calls.push(args);
      return { id: 't1', translated_text: '心肌梗死', created_at: '2026-11-07T00:00:00Z', session_id: args[0].session_id };
    },
  };
  return { translation, calls };
}

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function load(profile: string, provide: Record<string, unknown>) {
  const loaded = await loadExample(profile, { provide, official: fixture('empty-official.profile.json') });
  disposers.push(() => loaded.host.dispose());
  return loaded;
}

describe('example.translation-prompt', () => {
  it('forwards requests to the injected translation service with the default prompt', async () => {
    const { translation, calls } = fakeTranslation();
    const { host, result } = await load(dir('test.profile.json'), { translation });
    expect(result.degraded).toEqual([]);
    expect(result.installed.map((p) => p.id)).toEqual([ID]);
    await expect(host.ctx.get('exampleTranslationPrompt')!.translate(request)).resolves.toMatchObject({ translated_text: '心肌梗死', session_id: 's1' });
    expect(calls).toEqual([[{ ...request, prompt_override: DEFAULT_PROMPT }]]);
  });

  it('uses the prompt from the user profile config', async () => {
    const { translation, calls } = fakeTranslation();
    const { host, result } = await load(dir('user.profile.json'), { translation });
    expect(result.degraded).toEqual([]);
    await host.ctx.get('exampleTranslationPrompt')!.translate(request);
    expect(calls[0]![0].prompt_override).toBe('Translate for a nursing student. Keep drug names in English.');
  });

  it('is rejected with PERMISSION_UNDECLARED when the manifest does not declare service:translation', async () => {
    const { translation, calls } = fakeTranslation();
    const { host, result } = await load(fixture('undeclared.profile.json'), { translation });
    expect(result.installed).toEqual([]);
    expect(result.degraded).toEqual([{ id: ID, reason: expect.stringMatching(/^PERMISSION_UNDECLARED: .*translation/) }]);
    expect(host.ctx.get('exampleTranslationPrompt')).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('is degraded, not started, when the profile has no translation service', async () => {
    const { host, result } = await load(dir('test.profile.json'), {});
    expect(result.installed).toEqual([]);
    expect(result.degraded).toEqual([{ id: ID, reason: 'SERVICE_MISSING: missing service "translation"' }]);
    expect(host.runtime.get(ID)).toBeUndefined();
    expect(host.ctx.get('exampleTranslationPrompt')).toBeUndefined();
  });

  it('removes its service on unload and leaves the translation service alone', async () => {
    const { translation } = fakeTranslation();
    const { host } = await load(dir('test.profile.json'), { translation });
    await host.unload(ID);
    expect(host.ctx.get('exampleTranslationPrompt')).toBeUndefined();
    expect(host.ctx.get('translation')).toBe(translation);
  });

  it('has no UI half: the UI manifests list no module for it, so it loads no UI code and claims no i18n namespace', async () => {
    const { translation } = fakeTranslation();
    const { host } = await load(dir('test.profile.json'), { translation });
    expect((await host.invoke<{ id: string }[]>('plugin:ui|manifest', {})).map((e) => e.id)).not.toContain(ID);
    const v2 = await host.invoke<{ plugins: Record<string, unknown>[] }>('plugin:ui|manifest', { version: 2 });
    expect(v2.plugins.find((p) => p.id === ID)).toEqual({ id: ID, origin: 'community', platforms: ['desktop'], version: '1.0.0' });
  });
});
