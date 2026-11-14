// chatanki_executor.rs:5555–5690 execute_analyze on the production assembly:
// refs come from the real L04 session snapshot and L11 VFS rows, and the route
// plan goes through the published L02 llmAnkiRouting + llmRawPrompt to a real
// provider adapter. Only the remote HTTP endpoint is local.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createLogService } from '../../../platform/log/index.ts';
import { createSecretsService } from '../../../platform/secrets/index.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import {
  defaultBudgetConfig, InjectionBudgetManager, newInjectionItem,
} from '../../../platform/storage/injection-budget.ts';
import anki from '../../anki/index.ts';
import chat from '../../chat/index.ts';
import llm from '../../llm/index.ts';
import type { ApiConfig } from '../../llm/api.ts';
import providers from '../../llm-providers/index.ts';
import notes from '../../notes/index.ts';
import review from '../../review/index.ts';
import vfs from '../../vfs/index.ts';
import vfsIndex from '../../vfs-index/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import type { ToolExecutionContext } from '../api.ts';
import chatanki from '../index.ts';
import { createChatAnkiRoutePlanner } from '../src/route-planner.ts';

const NOTES_TEXT = '\n  第一章 细胞结构\n细胞膜由磷脂双分子层构成。\n线粒体是有氧呼吸的主要场所。';

function apiConfig(port: number): ApiConfig {
  return {
    id: 'cfg-plan', name: 'local planner', vendorId: null, vendorName: null, providerType: null,
    providerScope: null, authMode: null, apiProtocol: null, supportsOpenaiResponses: null,
    apiKey: 'local-test-key', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'gpt-local-plan',
    isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false,
    isImageGeneration: false, enabled: true, modelAdapter: 'general', maxOutputTokens: 8192,
    temperature: 0.7, supportsTools: false, geminiApiVersion: 'v1', isBuiltin: false,
    isReadOnly: false, reasoningEffort: null, reasoningMode: null, thinkingEnabled: false,
    thinkingBudget: null, includeThoughts: false, minP: null, topK: null, enableThinking: null,
    supportsReasoning: false, headers: null, topPOverride: null, frequencyPenaltyOverride: null,
    presencePenaltyOverride: null, repetitionPenalty: null, reasoningSplit: null, effort: null,
    verbosity: null, isFavorite: false, maxTokensLimit: null, contextWindow: null,
    extraBody: null, resolvedAdapterId: null,
  };
}

it('analyze resolves session and VFS refs and routes them through the published model2 planner', async () => {
  const requests: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'local-plan', object: 'chat.completion', created: 1, model: 'gpt-local-plan',
      choices: [{ index: 0, finish_reason: 'stop', message: {
        role: 'assistant',
        content: JSON.stringify({ route: 'vlm_full', confidence: 0.92, glossaryMode: false, reason: '图片是主要信息源' }),
      } }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    }));
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-analyze-assembly-'));
  const paths = createPaths({ dataDir: dir, platform: 'linux', env: {
    HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir,
  } });
  const log = createLogService({ paths, debug: false, version: 'test' });
  const secrets = createSecretsService({ os: paths.os, log: log.logger('chatanki_test'), keystore: null });
  const storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  try {
    expect((await storage.migrations.runAll()).success).toBe(true);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected local TCP address');
    const secureStore = secrets.openStore(dir, { keystore: null });
    const settings = createSettingsService({ db: () => storage.database('mistakes'), secureStore: () => secureStore, secrets });
    const host = await createTestHost({
      app: { dataDir: dir },
      plugins: [native, providers, llm, vfsRepos, notes, vfsIndex, vfs, chat, anki, review, chatanki],
      provide: {
        paths, log, secrets, settings, storage,
        injectionBudget: {
          defaultConfig: defaultBudgetConfig,
          createManager: (config: ConstructorParameters<typeof InjectionBudgetManager>[0]) => new InjectionBudgetManager(config),
          newItem: newInjectionItem,
        },
      },
    });
    try {
      await host.invoke('save_api_configurations', { configs: [apiConfig(address.port)] });
      await host.invoke('save_model_assignments', { assignments: { model2_config_id: 'cfg-plan' } });

      const chatDb = storage.database('chat_v2');
      chatDb.run(`INSERT INTO chat_v2_sessions (id, mode, persist_status, created_at, updated_at)
        VALUES ('sess_analyze', 'chat', 'active', '2026-11-07T00:00:00+00:00', '2026-11-07T00:00:00+00:00')`);
      chatDb.run(`INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp, meta_json)
        VALUES ('msg_analyze_user', 'sess_analyze', 'user', '[]', 1, ?1)`, [JSON.stringify({
        contextSnapshot: {
          userRefs: [{ resourceId: 'file_notes', hash: 'hash-notes', typeId: 'file', displayName: 'lecture-notes.pdf' }],
          retrievalRefs: [],
        },
      })]);

      const vfsDb = storage.database('vfs');
      vfsDb.run(`INSERT INTO resources (id, hash, type, source_id, created_at, updated_at) VALUES
        ('res_notes', 'hash-notes', 'file', NULL, 1, 1), ('res_diagram', 'hash-diagram', 'image', NULL, 1, 1)`);
      vfsDb.run(`INSERT INTO files (id, resource_id, sha256, file_name, size, created_at, updated_at, type, mime_type, extracted_text) VALUES
        ('file_notes', 'res_notes', 'sha-notes', 'notes-upload.pdf', 10, '2026-11-07', '2026-11-07', 'document', 'application/pdf', ?1),
        ('file_diagram', 'res_diagram', 'sha-diagram', 'diagram.png', 10, '2026-11-07', '2026-11-07', 'image', 'image/png', NULL)`,
      [NOTES_TEXT]);

      const context: ToolExecutionContext = {
        sessionId: 'sess_analyze', messageId: 'msg_analyze', blockId: 'blk_analyze',
        emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined,
        emitToolCallError: () => undefined, saveToolBlock: () => undefined, warn: () => undefined,
      };
      const result = await host.ctx.chatankiTools.execute({
        id: 'call_analyze', name: 'builtin-chatanki_analyze',
        arguments: { goal: '把讲义做成卡片', resourceIds: ['file_notes', 'res_diagram', 'file_missing'] },
      }, context);

      expect(result.success, result.error).toBe(true);
      const output = result.output as Record<string, any>;
      expect(output.metrics).toMatchObject({
        chars: [...NOTES_TEXT.trim()].length, refTotal: 2, refFiles: 1, refImages: 1, refOthers: 0,
      });
      expect(output.routing).toMatchObject({ route: 'vlm_full', routeSource: 'llm', reason: '图片是主要信息源' });
      expect(output.routing.confidence).toBeCloseTo(0.92, 5);
      expect(output.warnings).toEqual([expect.objectContaining({
        code: 'analyze_refs_unresolved', unresolvedIds: ['file_missing'],
      })]);

      expect(requests).toHaveLength(1);
      const prompt = JSON.stringify(JSON.parse(requests[0]!).messages);
      // The session snapshot's display name wins over the VFS file name for snapshot refs.
      expect(prompt).toContain('lecture-notes.pdf (file)');
      expect(prompt).not.toContain('notes-upload.pdf');
      expect(prompt).toContain('diagram.png (image)');
      // The main-model slot yields a Planner decision; the routed exit sent that config in JSON mode.
      expect(JSON.parse(requests[0]!).response_format).toEqual({ type: 'json_object' });
      expect(await host.ctx.llmAnkiRouting.resolveAnkiRoleDecision('planner', 'auto'))
        .toMatchObject({ role: 'planner', configId: 'cfg-plan' });
      expect(prompt).toContain('第一章 细胞结构');
    } finally {
      await host.dispose();
    }
  } finally {
    storage.dispose();
    await log.close();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

it('plan_route sends a Planner decision through the routed exit; a failed Planner call retries model2 once', async () => {
  const calls: unknown[][] = [];
  const warnings: string[] = [];
  const decision = { role: 'planner', configId: 'cfg-planner', model: 'planner-model' } as never;
  let routedFails = false;
  const rawPrompt = {
    callAnkiRoutedRawPrompt: async (...args: unknown[]) => {
      calls.push(['routed', ...args]);
      if (routedFails) throw new Error('planner offline');
      return { assistant_message: 'routed' } as never;
    },
    callModel2RawPrompt: async (...args: unknown[]) => {
      calls.push(['model2', ...args]);
      return { assistant_message: 'model2' } as never;
    },
  };
  const planner = createChatAnkiRoutePlanner(
    { resolveAnkiRoleDecision: async () => decision }, rawPrompt, (message) => warnings.push(message));
  await expect(planner.callAnkiRoutedRawPrompt('chatanki.plan_route', 'plan this')).resolves.toBe('routed');
  expect(calls).toEqual([['routed', decision, 'chatanki.plan_route', 'plan this', null]]);
  expect(warnings).toEqual([]);

  calls.length = 0;
  routedFails = true;
  await expect(planner.callAnkiRoutedRawPrompt('chatanki.plan_route', 'plan this')).resolves.toBe('model2');
  expect(calls).toEqual([['routed', decision, 'chatanki.plan_route', 'plan this', null], ['model2', 'plan this', null, 'anki']]);
  expect(warnings).toEqual(['[chatanki] Planner 槽调用失败，回退原 model2 路径: planner offline']);

  // decision=None: the routed exit already used model2, so its failure is not retried.
  calls.length = 0; warnings.length = 0;
  const noSlot = createChatAnkiRoutePlanner(
    { resolveAnkiRoleDecision: async () => null }, rawPrompt, (message) => warnings.push(message));
  await expect(noSlot.callAnkiRoutedRawPrompt('chatanki.plan_route', 'p')).rejects.toThrow('planner offline');
  expect(calls).toEqual([['routed', null, 'chatanki.plan_route', 'p', null]]);
  expect(warnings).toEqual([]);
});
