/**
 * 只有 Host 半的社区插件：注入官方翻译服务 `translation`，提供 `exampleTranslationPrompt`，
 * 用 profile 配置的提示词（`prompt_override`）转发翻译请求。
 *
 * 社区插件的 `inject` 必须 ⊆ package.json 的 `permissions`（`service:<服务名>`）∪ 隐式授予的 `log`，
 * 否则以 PERMISSION_UNDECLARED 拒绝装载（host/kernel/manifest.ts 的 grantedServices，API.md §16.4）。
 * inject 是硬依赖：profile 里没有提供 `translation` 的插件时，本插件以 `missing service "translation"` 降级。
 */
import { definePlugin, Schema } from '../../../host/kernel/api.ts';
import type { TranslationRequest, TranslationResponse } from '../../../host/plugins/translation/api.ts';

export const DEFAULT_PROMPT = 'Translate for a medical student. Preserve technical terms and explain no extra content.';

export interface ExampleTranslationPromptConfig {
  prompt: string;
}

export const Config: Schema<Partial<ExampleTranslationPromptConfig>, ExampleTranslationPromptConfig> = Schema.object({
  prompt: Schema.string().default(DEFAULT_PROMPT).description('作为 prompt_override 交给官方翻译服务'),
});

export interface ExampleTranslationPromptService {
  /** 与 `TranslationService.translateTextStream` 同参，`prompt_override` 换成配置的提示词。 */
  translate(request: TranslationRequest): Promise<TranslationResponse | null>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    exampleTranslationPrompt: ExampleTranslationPromptService;
  }
}

export default definePlugin<ExampleTranslationPromptConfig>({
  meta: {
    id: 'example.translation-prompt',
    version: '1.0.0',
    platforms: ['desktop'],
    provides: ['exampleTranslationPrompt'],
  },
  inject: ['translation'],
  Config,
  apply(ctx, config) {
    ctx.provide('exampleTranslationPrompt', {
      translate: (request) => ctx.translation.translateTextStream({ ...request, prompt_override: config.prompt }),
    });
  },
});
