/**
 * W22 B-side dispatch (G3 dry run: `builtin-chatanki_*` failed with
 * "Cannot read properties of undefined (reading 'emitter')"). The L04 registry hands the
 * registered chatanki unit a `ChatExecutionContext` class instance whose lifecycle methods
 * read `this.emitter`. Real chat / anki / review / agentTools plugins on an isolated migrated DB.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import agentSkills from '../../agent-skills/index.ts';
import anki from '../../anki/index.ts';
import chat from '../../chat/index.ts';
import type { ChatV2EventEmitter, ToolExecutor } from '../../chat/api.ts';
import review from '../../review/index.ts';
import chatanki from '../index.ts';

const SESSION = 'session-registry-dispatch';
const MESSAGE = 'message-registry-dispatch';
const BLOCK = 'block-registry-dispatch';
const ROUND = 'round-registry-dispatch';
const NOT_FOUND_TEXT = 'blocks.ankiCards.errors.statusNotFound: no live card task found for the given id under this session;';

let dir = '';
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-registry-dispatch-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, chat, anki, review, agentSkills, chatanki],
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage,
      settings: createSettingsStore({
        db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
      }),
      llm: {}, vfs: {},
    },
  });
}, 60_000);

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

type EmitterCall = [method: string, ...args: unknown[]];

function recordingEmitter(): { emitter: ChatV2EventEmitter; calls: EmitterCall[] } {
  const calls: EmitterCall[] = [];
  const record = (method: string) => (...args: unknown[]) => { calls.push([method, ...args]); };
  return {
    calls,
    emitter: {
      emitStart: record('emitStart'), emitChunk: record('emitChunk'), emitEnd: record('emitEnd'),
      emitError: record('emitError'), emitStartWithMeta: record('emitStartWithMeta'),
      emitEndWithMeta: record('emitEndWithMeta'), emitErrorWithMeta: record('emitErrorWithMeta'),
    },
  };
}

/** The production L04 registry over what L07 `agentTools` actually holds. */
function registry() {
  return host.ctx.chatSession.createExecutorRegistry(
    host.ctx.agentTools.toolExecutors() as readonly ToolExecutor[],
    { ignoresBroadApprovalBypassForArgs: () => false, neverRememberApprovalForArgs: () => false },
  );
}

function executionContext(emitter: ChatV2EventEmitter) {
  const context = host.ctx.chatSession.createExecutionContext({
    sessionId: SESSION, messageId: MESSAGE, blockId: BLOCK, emitter, services: host.ctx,
    toolRegistry: {} as never,
  });
  context.round_id = ROUND;
  return context;
}

it('W22 registry dispatch drives ChatExecutionContext lifecycle methods with their own this (B-side emitter crash)', async () => {
  const { emitter, calls } = recordingEmitter();
  const stats = await registry().execute(
    { id: 'call-registry-stats', name: 'builtin-chatanki_review_stats', arguments: {} }, executionContext(emitter));
  expect(stats.success, stats.error ?? undefined).toBe(true);
  expect(stats.output).toMatchObject({ status: 'ok', total: 0, due: 0 });
  expect(calls).toEqual([
    ['emitStartWithMeta', 'tool_call', MESSAGE, BLOCK,
      { toolName: 'builtin-chatanki_review_stats', toolInput: {}, toolCallId: 'call-registry-stats' }, null, null, ROUND],
    ['emitEndWithMeta', 'tool_call', BLOCK, { result: stats.output, durationMs: expect.any(Number) }, null, null, ROUND],
  ]);

  calls.length = 0;
  const invalid = await registry().execute(
    { id: 'call-registry-invalid', name: 'builtin-chatanki_set_library_suspended', arguments: {} },
    executionContext(emitter));
  expect(invalid.success).toBe(false);
  expect(invalid.error).toBe('Invalid chatanki_set_library_suspended arguments: missing field `cardId`');
  expect(calls).toEqual([
    ['emitStartWithMeta', 'tool_call', MESSAGE, BLOCK,
      { toolName: 'builtin-chatanki_set_library_suspended', toolInput: {}, toolCallId: 'call-registry-invalid' }, null, null, ROUND],
    ['emitErrorWithMeta', 'tool_call', BLOCK, invalid.error, null, null, ROUND],
  ]);
});

it('W22 update/delete_library_card join the registry tool face only while L16 publishes getAnkiAgentLibraryCard', async () => {
  // The chatanki schemas G3 chatanki.library.list.bad_args.negative_page offers, in request order.
  const rustFace = [
    'builtin-chatanki_list_library_cards', 'builtin-chatanki_update_library_card',
    'builtin-chatanki_delete_library_card', 'builtin-chatanki_get_cards',
    'builtin-chatanki_update_card', 'builtin-chatanki_delete_card',
  ];
  const gated = new Set(['builtin-chatanki_update_library_card', 'builtin-chatanki_delete_library_card']);
  const service = host.ctx.anki as unknown as Record<string, unknown>;
  // Shadow the owner method (absent) whether or not the published L16 already carries it.
  Object.defineProperty(service, 'getAnkiAgentLibraryCard', { value: undefined, configurable: true, writable: true });
  try {
    const live = registry();
    // chat-pipeline advertises a builtin name exactly when the registry has a specific executor for it.
    expect(rustFace.filter((name) => live.hasSpecificExecutor(name)))
      .toEqual(rustFace.filter((name) => !gated.has(name)));
    expect(host.ctx.chatankiTools.canHandle('chatanki_delete_library_card')).toBe(false);

    service.getAnkiAgentLibraryCard = () => null;
    expect(rustFace.filter((name) => live.hasSpecificExecutor(name))).toEqual(rustFace);
    expect(rustFace.filter((name) => registry().hasSpecificExecutor(name))).toEqual(rustFace);
    expect(host.ctx.chatankiTools.canHandle('chatanki_delete_library_card')).toBe(true);

    const { emitter, calls } = recordingEmitter();
    const missing = await live.execute({
      id: 'call-registry-update', name: 'builtin-chatanki_update_library_card',
      arguments: { cardId: 'lib-missing', expectedVersion: 'v1', patch: { front: 'f' } },
    }, executionContext(emitter));
    expect(missing.success).toBe(false);
    expect(missing.error?.startsWith(NOT_FOUND_TEXT)).toBe(true);
    expect(calls.map(([method]) => method)).toEqual(['emitStartWithMeta', 'emitErrorWithMeta']);
  } finally {
    delete service.getAnkiAgentLibraryCard;
  }
});
