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
import review from '../../review/index.ts';
import type { AnkiCard, AnkiCardVersionUpdate, ToolExecutionContext } from '../api.ts';
import chatanki from '../index.ts';
import { parseCreateRequest } from '../src/template-executor.ts';

it('C2 retemplate fill consumes published llmRawPrompt and real providers after the owner transaction', async () => {
  // Rust chatanki_executor.rs:4443-4461 calls model2(prompt, None, Anki).
  // Only the remote HTTP endpoint is local; L01 adapters, L02 raw prompts,
  // L04 UI reads, L16 CAS and F4 settings/secrets are their real implementations.
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let responseContent = JSON.stringify({ cards: [{ cardId: 'card-fill', fields: { Example: 'generated example' } }] });
  let beforeReply: (() => void) | null = null;
  const interleavingErrors: unknown[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ url: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    try { beforeReply?.(); }
    catch (error) { interleavingErrors.push(error); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'local-retemplate', object: 'chat.completion', created: 1, model: 'gpt-local-fill',
      choices: [{ index: 0, finish_reason: 'stop', message: {
        role: 'assistant', content: responseContent,
      } }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    }));
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-real-model2-'));
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
      app: { dataDir: dir }, plugins: [native, providers, llm, chat, anki, review, chatanki],
      provide: {
        paths, log, secrets, settings, storage,
        // These unused VFS capabilities are registration prerequisites, not providers under test.
        vfs: {}, vfsDatabase: {}, vfsRepo: { essays: {} },
        injectionBudget: {
          defaultConfig: defaultBudgetConfig,
          createManager: (config: ConstructorParameters<typeof InjectionBudgetManager>[0]) => new InjectionBudgetManager(config),
          newItem: newInjectionItem,
        },
      },
    });
    try {
      const config: ApiConfig = {
        id: 'cfg-fill', name: 'local fill', vendorId: null, vendorName: null, providerType: null,
        providerScope: null, authMode: null, apiProtocol: null, supportsOpenaiResponses: null,
        // provider_quirks.rs:159 + model2_pipeline.rs:9074: force_json applies to gpt-*.
        apiKey: 'local-test-key', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'gpt-local-fill',
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
      await host.invoke('save_api_configurations', { configs: [config] });
      await host.invoke('save_model_assignments', { assignments: { model2_config_id: config.id } });
      const templateId = await host.invoke<string>('create_custom_template', { request: parseCreateRequest({
        name: 'Fill target', noteType: 'Basic', fields: ['Front', 'Back', 'Example'],
        frontTemplate: '{{Front}}', backTemplate: '{{Back}} {{Example}}', generationPrompt: 'generate cards',
        fieldExtractionRules: {
          Front: { field_type: 'Text', is_required: true, description: 'front' },
          Back: { field_type: 'Text', is_required: true, description: 'back' },
          Example: { field_type: 'Text', is_required: false, description: 'example' },
        },
      }) });
      host.ctx.anki.documents.insertDocumentTask({
        id: 'task-fill', document_id: 'doc-fill', original_document_name: 'fill.md',
        segment_index: 0, content_segment: 'segment', status: 'Completed',
        created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T00:00:00Z',
        error_message: null, anki_generation_options_json: '{}',
      });
      host.ctx.anki.documents.setDocumentSessionSource('doc-fill', 'session-fill');
      const card: AnkiCard = {
        id: 'card-fill', front: 'original question', back: 'answer', text: null,
        tags: [], images: [], task_id: 'task-fill', is_error_card: false, error_content: null,
        created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T00:00:00Z',
        extra_fields: {}, template_id: null,
      };
      const inserted = host.ctx.anki.cards.insertCardsForDocument('doc-fill', 'session-fill', [card]);
      expect(inserted).toHaveLength(1);
      const context: ToolExecutionContext = {
        sessionId: 'session-fill', messageId: 'message-fill', blockId: 'block-fill',
        emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined,
        emitToolCallError: () => undefined, saveToolBlock: () => undefined, warn: () => undefined,
      };
      const result = await host.ctx.chatankiTools.execute({
        id: 'call-fill', name: 'chatanki_retemplate', arguments: {
          documentId: 'doc-fill', targetTemplateId: templateId, strategy: 'fill_missing_llm',
          expectedVersions: { 'card-fill': inserted[0]!.updated_at },
        },
      }, context);
      expect(result.success, result.error).toBe(true);
      expect(result.output).toMatchObject({ status: 'ok', missingCards: 0, fill: {
        attempted: 1, filled: 1, partial: 0, skipped: 0, conflicts: 0, failed: 0,
      } });
      const saved = host.ctx.anki.cards.getCardForSession(card.id, 'session-fill')!.card;
      expect(saved.template_id).toBe(templateId);
      expect(saved.extra_fields.Example).toBe('generated example');
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe('/v1/chat/completions');
      expect(JSON.stringify(requests[0]!.body.messages)).toContain('Example');
      expect(requests[0]!.body.response_format).toEqual({ type: 'json_object' });

      // Rust :4432-4461: a Phase 2 parse failure must not undo committed Phase 1.
      const malformedCard = { ...card, id: 'card-fill-malformed', front: 'question for malformed response' };
      const malformedInserted = host.ctx.anki.cards.insertCardsForDocument('doc-fill', 'session-fill', [malformedCard]);
      expect(malformedInserted).toHaveLength(1);
      const phase1Snapshots: AnkiCard[] = [];
      responseContent = 'no JSON object';
      beforeReply = () => {
        phase1Snapshots.push(host.ctx.anki.cards.getCardForSession(malformedCard.id, 'session-fill')!.card);
      };
      const failedFill = await host.ctx.chatankiTools.execute({
        id: 'call-fill-malformed', name: 'chatanki_retemplate', arguments: {
          cardIds: [malformedCard.id], targetTemplateId: templateId, strategy: 'fill_missing_llm',
          expectedVersions: { [malformedCard.id]: malformedInserted[0]!.updated_at },
        },
      }, context);
      expect(interleavingErrors).toEqual([]);
      expect(phase1Snapshots).toHaveLength(1);
      expect(phase1Snapshots[0]!.template_id).toBe(templateId);
      expect(phase1Snapshots[0]!.updated_at).not.toBe(malformedInserted[0]!.updated_at);
      expect(failedFill.success, failedFill.error).toBe(true);
      expect(failedFill.output).toMatchObject({
        status: 'ok', mutationApplied: true, missingCards: 1,
        cards: [{
          id: malformedCard.id, fillStatus: 'failed', filledFields: [], missingFields: ['Example'],
          fillError: 'fill response contains no JSON object',
        }],
        fill: { attempted: 1, filled: 0, partial: 0, skipped: 0, conflicts: 0, failed: 1 },
      });
      expect(host.ctx.anki.cards.getCardForSession(malformedCard.id, 'session-fill')!.card)
        .toEqual(phase1Snapshots[0]);
      expect(requests).toHaveLength(2);

      // Rust :4466-4472 / :18489-18495: a competing owner write during the
      // provider request wins; the fill CAS must return its current card, not overwrite it.
      const racedCard = { ...card, id: 'card-fill-raced', front: 'question for competing editor' };
      const racedInserted = host.ctx.anki.cards.insertCardsForDocument('doc-fill', 'session-fill', [racedCard]);
      expect(racedInserted).toHaveLength(1);
      const competingWrites: AnkiCardVersionUpdate[] = [];
      responseContent = JSON.stringify({ cards: [{ cardId: racedCard.id, fields: { Example: 'must not overwrite' } }] });
      beforeReply = () => {
        const phase1 = host.ctx.anki.cards.getCardForSession(racedCard.id, 'session-fill')!.card;
        competingWrites.push(host.ctx.anki.cards.updateCardIfVersionForSession({
          ...phase1, front: 'edited while model request was in flight',
          extra_fields: { ...phase1.extra_fields, Example: 'manual example' },
        }, phase1.updated_at, 'session-fill'));
      };
      const conflicted = await host.ctx.chatankiTools.execute({
        id: 'call-fill-raced', name: 'chatanki_retemplate', arguments: {
          cardIds: [racedCard.id], targetTemplateId: templateId, strategy: 'fill_missing_llm',
          expectedVersions: { [racedCard.id]: racedInserted[0]!.updated_at },
        },
      }, context);
      expect(interleavingErrors).toEqual([]);
      expect(competingWrites).toHaveLength(1);
      const winner = competingWrites[0]!;
      expect(winner.kind).toBe('updated');
      if (winner.kind !== 'updated') throw new Error(`competing owner write failed: ${winner.kind}`);
      expect(conflicted.success, conflicted.error).toBe(true);
      expect(conflicted.output).toMatchObject({
        status: 'ok', mutationApplied: true,
        cards: [{
          id: racedCard.id, fillStatus: 'conflict', fillError: 'version_conflict', filledFields: [],
          front: winner.card.front, version: winner.card.updated_at,
        }],
        fill: { attempted: 1, filled: 0, partial: 0, skipped: 0, conflicts: 1, failed: 0 },
      });
      expect(winner.card.template_id).toBe(templateId);
      expect(winner.card.extra_fields.Example).toBe('manual example');
      expect(host.ctx.anki.cards.getCardForSession(racedCard.id, 'session-fill')!.card)
        .toEqual(winner.card);
      expect(requests).toHaveLength(3);
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
