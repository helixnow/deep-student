/**
 * Every command of vfs-handlers, media, vfs-index and translation must answer an Err path with a classified value that fits
 * its contract `error` schema (host/kernel/API.md §2.3): never the unified internal error (HandlerPanic here),
 * never the debug contract-violation diagnostic, never a promise that does not settle.
 *
 * Two Err sources reach almost every handler in Rust: argument values the command rejects, and a failing VFS
 * connection (`get_conn_safe()?` / `map_err(|e| e.to_string())`); translation reads its model configuration through
 * the settings database instead, so that one is closed too when translation runs. Arguments are the smallest values the
 * contract schema accepts (kernel `minimalCommandArgs`), which most commands refuse as invalid ids or unknown records.
 */
import { describe, expect, it } from 'vitest';
import { unsettledCommandErrors, type TestPluginEntry } from '../../../kernel/testing.ts';
import { image } from '../../../platform/native/image/index.ts';
import { defaultBudgetConfig, InjectionBudgetManager, newInjectionItem } from '../../../platform/storage/injection-budget.ts';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
import llm from '../../llm/index.ts';
import { AnthropicAdapter, GeminiAdapter, OpenAIAdapter, OpenAIResponsesAdapter, type ProviderKind } from '../../llm-providers/api.ts';
import media from '../../media/index.ts';
import translation from '../../translation/index.ts';
import vfsIndex from '../../vfs-index/index.ts';
import vfsHandlers from '../index.ts';
import { createVfsHost } from './harness.ts';

/** Commands that reach the network, an LLM, audio output or a long-running background job. */
const EXTERNAL = new Set([
  'tts_speak', 'voice_input_transcribe', 'test_ocr_engine', 'validate_ocr_model', 'handout_llm_complete',
  'handout_vlm_caption', 'start_pdf_ocr_backend', 'process_pdf_ocr', 'media_transcribe_start', 'todo_ai_breakdown',
  'media_bilibili_login_qr_start', 'media_bilibili_login_qr_poll', 'media_bilibili_probe', 'media_bilibili_create',
  'media_bilibili_import_subtitle', 'media_bilibili_stream_quality',
]);

const declared = (plugins: readonly { meta: { commands?: readonly string[] } }[]) => plugins
  .flatMap(plugin => plugin.meta.commands ?? []).filter(command => !EXTERNAL.has(command));

/** The real LLM manager over the harness settings and VFS; no model is configured, so nothing reaches a provider. */
const translationHost = {
  plugins: [llm, translation] as TestPluginEntry[],
  provide: {
    secrets: { isSensitiveKey: () => false, isEncryptedFormat: () => false,
      openCrypto: async () => ({ migratePlaintextKey: (value: string) => value }) },
    llmAdapters: { createAdapter: (kind: ProviderKind) => kind === 'anthropic' ? new AnthropicAdapter()
      : kind === 'gemini' ? new GeminiAdapter() : kind === 'openai_responses' ? new OpenAIResponsesAdapter() : new OpenAIAdapter() },
    nativeTokenizer: tokenizer, nativeImage: image,
    injectionBudget: { defaultConfig: defaultBudgetConfig, newItem: newInjectionItem,
      createManager: (config: ConstructorParameters<typeof InjectionBudgetManager>[0]) => new InjectionBudgetManager(config) },
    llmCodexAuth: { status: async () => ({ hasUsableSession: false }) },
  },
};

async function failures(closeDatabases: boolean, withTranslation = false): Promise<string[]> {
  const vfs = await createVfsHost(withTranslation ? translationHost : {});
  try {
    const closing = closeDatabases ? withTranslation ? ['vfs', 'mistakes'] as const : ['vfs'] as const : [];
    for (const name of closing) (vfs.storage.database(name) as unknown as { close(): void }).close();
    return await unsettledCommandErrors(vfs.host, withTranslation ? [translation] : [vfsHandlers, media, vfsIndex],
      { exclude: EXTERNAL });
  } finally {
    await vfs.dispose();
  }
}

describe('command Err paths stay classified and contract-shaped', { timeout: 600_000 }, () => {
  it('covers every declared command of the three plugins except external ones', () => {
    expect(declared([vfsHandlers, media, vfsIndex]).length).toBeGreaterThan(200);
  });

  it('minimal contract arguments', async () => {
    expect(await failures(false)).toEqual([]);
  });

  it('VFS connection failure', async () => {
    expect(await failures(true)).toEqual([]);
  });

  it('covers every declared translation command', () => {
    expect(declared([translation])).toEqual([...translation.meta.commands ?? []]);
  });

  it('translation: minimal contract arguments', async () => {
    expect(await failures(false, true)).toEqual([]);
  });

  it('translation: VFS and settings connection failure', async () => {
    expect(await failures(true, true)).toEqual([]);
  });
});
