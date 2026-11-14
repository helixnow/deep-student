/** Real L12 SQLite retrieval + L02/provider HTTP adapter; only the remote model is a loopback server. */
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import paths from '../../../platform/paths/index.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import { image } from '../../../platform/native/image/index.ts';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
import { defaultBudgetConfig, InjectionBudgetManager, newInjectionItem } from '../../../platform/storage/injection-budget.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../../notes/index.ts';
import vfsIndex from '../../vfs-index/index.ts';
import vfs from '../../vfs/index.ts';
import providers from '../../llm-providers/index.ts';
import llm from '../../llm/index.ts';
import type { ApiConfig } from '../../llm/api.ts';
import memory from '../index.ts';
import { createMigratedMemoryStorage } from './fixtures/migrated-schema.ts';
import { createLogDouble } from './support.ts';

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { await dispose?.(); dispose = undefined; });

it('HPIAS retrieves indexed local evidence and calls the real config-id HTTP adapter before completing', async () => {
  const requests: Array<{ body: Record<string, unknown>; sessionHeader: string | string[] | undefined }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
      sessionHeader: req.headers['x-opencode-session'] });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '  ## 综合结论\nLocal evidence report.  ' } }],
      usage: { prompt_tokens: 20, completion_tokens: 8 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { dir, storage } = await createMigratedMemoryStorage('hpias-real-retrieval-');
  let host: Awaited<ReturnType<typeof createTestHost>> | undefined;
  dispose = async () => {
    try { await host?.dispose(); }
    finally {
      storage.dispose(); rmSync(dir, { recursive: true, force: true });
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
  const warnings: string[] = [];
  const settings = createSettingsService({ db: () => storage.database('mistakes'), secureStore: () => null,
    secrets: { isSensitiveKey: () => false } });
  host = await createTestHost({
    plugins: [paths, vfsRepos, notes, providers, llm, [vfsIndex, { indexWorker: { enabled: false } }], vfs,
      [memory, { hpiasBackend: 'retrieval' }]],
    provide: { storage, settings, log: createLogDouble(warnings), nativeImage: image, nativeTokenizer: tokenizer,
      secrets: { isEncryptedFormat: () => false, openCrypto: async () => ({ migratePlaintextKey: (value: string) => value }) },
      injectionBudget: { defaultConfig: defaultBudgetConfig,
        createManager: (config: ConstructorParameters<typeof InjectionBudgetManager>[0]) => new InjectionBudgetManager(config),
        newItem: newInjectionItem },
    },
    app: { dataDir: dir },
  });
  const config: ApiConfig = { id: 'research-model', name: 'research-model', enabled: true,
    model: 'gpt-4o-mini', apiKey: 'local-test-key', apiProtocol: 'openai_chat_completions',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    vendorId: null, vendorName: null, providerType: null, providerScope: null, authMode: null,
    supportsOpenaiResponses: null, isMultimodal: false, isReasoning: false, isEmbedding: false,
    isReranker: false, isImageGeneration: false, modelAdapter: 'general', maxOutputTokens: 8192,
    temperature: 0.7, supportsTools: false, geminiApiVersion: 'v1', isBuiltin: false, isReadOnly: false,
    reasoningEffort: null, reasoningMode: null, thinkingEnabled: false, thinkingBudget: null,
    includeThoughts: false, minP: null, topK: null, enableThinking: null, supportsReasoning: false,
    headers: null, topPOverride: null, frequencyPenaltyOverride: null, presencePenaltyOverride: null,
    repetitionPenalty: null, reasoningSplit: null, effort: null, verbosity: null, isFavorite: false,
    maxTokensLimit: null, contextWindow: null, extraBody: null, resolvedAdapterId: null,
  };
  await host.ctx.llm.saveApiConfigurations([config]);
  await host.ctx.llm.saveModelAssignments({ model2_config_id: 'research-model' });
  await host.ctx.llm.saveFailoverPolicy({ ...(await host.ctx.llm.getFailoverPolicy()), enabled: false });

  const note = host.ctx.notes.repository.createNote({ title: 'Research evidence', content: 'quasar telescope observation' });
  // The indexed fixture is persisted in the actual migrated VFS schema; no retrieval response double.
  storage.database('vfs').run(`INSERT INTO vfs_index_units
    (id, resource_id, unit_index, text_content, text_source, text_required, text_state, created_at, updated_at)
    VALUES (?1, ?2, 0, ?3, 'native', 1, 'indexed', 1, 1)`,
  ['unit-hpias', note.resourceId, 'quasar telescope observation']);

  host.ctx.hpiasResearch.startFromIntent({ window: { window: 'main', webview: 'main' }, sessionId: 'real-hpias',
    title: 'quasar', intent: { blocks: [{ type: 'research-report', props: { body: 'must not use stub body' } }] } });
  expect(host.eventsNamed('hpias_event')[0]).toMatchObject({ type: 'session_started', session_id: 'real-hpias' });
  await expect.poll(() => host!.eventsNamed('hpias_event').at(-1), { timeout: 5000 })
    .toMatchObject({ type: 'session_completed', session_id: 'real-hpias' });
  const events = host.eventsNamed('hpias_event') as Array<Record<string, unknown>>;
  expect(events.find(e => e.type === 'retrieval_completed')).toMatchObject({ fetched: 1 });
  expect(events.find(e => e.type === 'subagent_completed')).toMatchObject({
    summary_md: 'Research evidence：quasar telescope observation…', citations: [[note.id, 1]],
  });
  expect(events.find(e => e.type === 'synthesis_updated')?.synthesis).toBe('## 综合结论\nLocal evidence report.');
  expect(requests).toHaveLength(1);
  expect(requests[0]?.body).toMatchObject({ model: 'gpt-4o-mini', stream: false });
  expect(requests[0]?.body).not.toHaveProperty('response_format');
  expect(JSON.stringify(requests[0]?.body.messages)).toContain(`[${note.id}-1] Research evidence — quasar telescope observation`);
  expect(requests[0]?.sessionHeader).toBeUndefined();
  expect(warnings.filter(message => message.includes('[Hpias'))).toEqual([]);
});
