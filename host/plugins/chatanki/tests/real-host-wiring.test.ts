/**
 * C1/C2 evidence: boot the lane next to the *published* L16 `anki`, L15
 * `review` and L07 `agentTools` plugins, then execute a tool through the L07
 * registry. This exercises the real Cordis service names and proves the
 * registered wrapper hydrates from L15 instead of bypassing `hydrate`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import agentSkills from '../../agent-skills/index.ts';
import anki from '../../anki/index.ts';
import review from '../../review/index.ts';
import type { AnkiCard, ToolExecutionContext } from '../api.ts';
import chatanki from '../index.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';

it('C1/C2 starts with published anki/review/agentTools and hydrates registry calls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-real-host-'));
  const storage = createStorageService({
    baseDir: dir, dataLocalDir: path.join(dir, 'local'),
  });
  try {
    const migration = await storage.migrations.runAll();
    expect(migration.success).toBe(true);
    const host = await createTestHost({
      app: { dataDir: dir },
      plugins: [native, anki, review, agentSkills, chatanki],
      provide: {
        paths: {
          appDataDir: dir,
          os: { home: dir, data: dir, temp: os.tmpdir() },
        },
        settings: {
          get: () => null,
          save: () => undefined,
          getSetting: () => null,
          saveSetting: () => undefined,
        },
        llm: {},
        storage,
      },
    });
    try {
      // C1: the plugin started without the legacy `anki@1` name.
      expect(host.ctx.anki).toBeDefined();
      expect(host.ctx.chatankiTools).toBeDefined();

      // C2: L07 published the registry and holds chatanki wrappers.
      const registered = host.ctx.agentTools.toolExecutors();
      const executor = registered.find((candidate) => candidate.name() === 'ChatAnkiToolExecutor') as
        | (typeof registered[number] & {
          sensitivityLevelForCall?(tool: string, args: unknown): string;
          hasDynamicSensitivity?(tool: string): boolean;
        })
        | undefined;
      expect(executor).toBeDefined();
      expect(executor?.execute).toBeTypeOf('function');
      expect(executor?.sensitivityLevelForCall?.('chatanki_transform', {
        transform: { script: { language: 'python', code: 'print(1)' } },
      })).toBe('high');
      expect(executor?.hasDynamicSensitivity?.('chatanki_transform')).toBe(true);

      const starts: unknown[][] = [];
      const ends: unknown[][] = [];
      const saved: unknown[] = [];
      const result = await executor!.execute!({
        id: 'call-real-host-stats', name: 'chatanki_review_stats', arguments: {},
      }, {
        // Shape of L04 `ExecutionContext`: the lifecycle events are top-level
        // methods, not `emitter.emitToolCallStart`.
        session_id: 'session-real-host',
        message_id: 'message-real-host',
        block_id: 'block-real-host',
        variant_id: null,
        emitter: {
          emitError: () => undefined,
          emitChunk: () => undefined,
        },
        emitToolCallStart: (...args: unknown[]) => { starts.push(args); },
        emitToolCallEnd: (...args: unknown[]) => { ends.push(args); },
        emitToolCallError: () => undefined,
        runId: () => 'run-real-host',
        isCancelled: () => false,
        saveToolBlock: (value: unknown) => { saved.push(value); },
      }) as {
        success: boolean;
        output: Record<string, unknown>;
        error?: string;
      };

      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({ status: 'ok', total: 0, due: 0 });
      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(saved).toHaveLength(1);

      // L16 `anki.saveJsonFile` is hydrated into the JSON export sink.
      const repo = new CardStoreDouble();
      const taskId = repo.seedDocument('doc-real-export', 'session-real-host');
      repo.insertCard(exportCard('card-real-export', taskId), 'doc-real-export');
      const exportContext: ToolExecutionContext = {
        sessionId: 'session-real-host',
        messageId: 'message-real-host',
        blockId: 'block-real-export',
        cards: repo,
        emitToolCallStart: () => undefined,
        emitToolCallEnd: () => undefined,
        emitToolCallError: () => undefined,
        saveToolBlock: () => undefined,
        warn: () => undefined,
      };
      const exported = await host.ctx.chatankiTools.execute({
        id: 'call-real-export',
        name: 'chatanki_export',
        arguments: { documentId: 'doc-real-export', format: 'json' },
      }, exportContext);
      expect(exported.success).toBe(true);
      const path = (exported.output as Record<string, unknown>).path;
      expect(path).toBeTypeOf('string');
      const written = JSON.parse(fs.readFileSync(path as string, 'utf8')) as unknown[];
      expect(written).toHaveLength(1);
      fs.rmSync(path as string, { force: true });

      // L15 `getReviewStatesForSession` is hydrated. The review DB has no row
      // for this card, so the real `CommandError(NotFound)` exercises C7's
      // published-error mapping end to end.
      const gotCards = await host.ctx.chatankiTools.execute({
        id: 'call-real-get-cards',
        name: 'chatanki_get_cards',
        arguments: { documentId: 'doc-real-export' },
      }, exportContext);
      expect(gotCards.success).toBe(false);
      expect(gotCards.error).toContain('blocks.ankiCards.errors.statusNotFound');

      // F7 async nativeRegex is hydrated for the production transform path.
      const transformed = await host.ctx.chatankiTools.execute({
        id: 'call-real-transform',
        name: 'chatanki_transform',
        arguments: {
          documentId: 'doc-real-export',
          mode: 'dry_run',
          transform: {
            ops: [{ op: 'regex_replace', field: 'front', pattern: 'fr(.+?)nt', replacement: 'FR${1}NT' }],
          },
        },
      }, exportContext);
      expect(transformed.success).toBe(true);
      const diff = (transformed.output as Record<string, unknown>).diff as Array<Record<string, unknown>>;
      expect((diff[0]?.after as Record<string, unknown>).front).toBe('FRoNT');
    } finally {
      await host.dispose();
    }
  } finally {
    storage.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function exportCard(id: string, taskId: string): AnkiCard {
  return {
    id, front: 'front', back: 'back', text: null, tags: [], images: [], task_id: taskId,
    is_error_card: false, error_content: null,
    created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T01:00:00Z',
    extra_fields: {}, template_id: null,
  };
}
