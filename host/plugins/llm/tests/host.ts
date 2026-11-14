import { createTestHost as createKernelTestHost, type TestHostOptions } from '../../../kernel/testing.ts';
import { tmpdir } from 'node:os';
import { createNodeFiles } from '../../../platform/files/index.ts';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
import { image } from '../../../platform/native/image/index.ts';
import { OpenAIAdapter, OpenAIResponsesAdapter, AnthropicAdapter, GeminiAdapter, type ProviderKind } from '../../llm-providers/api.ts';
import { defaultBudgetConfig, InjectionBudgetManager, newInjectionItem } from '../../../platform/storage/injection-budget.ts';
export const realInjectionBudget = { defaultConfig: defaultBudgetConfig,
  createManager: (config: ConstructorParameters<typeof InjectionBudgetManager>[0]) => new InjectionBudgetManager(config),
  newItem: newInjectionItem };

/** These configuration-only tests do not call the essay storage/transport ports. */
export function createTestHost(options: TestHostOptions) {
  return createKernelTestHost({ ...options, provide: {
    vfsDatabase: {}, 'vfsRepo': { essays: {} }, llmAdapters: { createAdapter: (kind: ProviderKind) =>
      kind === 'anthropic' ? new AnthropicAdapter() : kind === 'gemini' ? new GeminiAdapter()
        : kind === 'openai_responses' ? new OpenAIResponsesAdapter() : new OpenAIAdapter() }, nativeTokenizer: tokenizer, nativeImage: image,
    injectionBudget: realInjectionBudget, llmCodexAuth: { status: async () => ({ hasUsableSession: false }) },
    // Test host data dirs live under the OS temp dir.
    files: createNodeFiles({ roots: [{ name: 'temp', path: tmpdir() }] }), ...options.provide,
  } });
}
