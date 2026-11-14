import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  AnkiCard, TransformSandboxBackend, TransformSandboxEffects, TransformSandboxProcess,
  TransformSandboxSpawnRequest, ToolCall, ToolExecutionContext, ToolResultInfo,
} from '../api.ts';
import { regex as nativeRegexEngine } from '../../../platform/native/regex/index.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import chatanki from '../index.ts';
import { ChatAnkiExecutor } from '../src/chatanki-executor.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';
import { ChatBlockStoreDouble } from './chat-block-double.ts';
import { setTransformFs } from '../src/transform-script-fs.ts';
import { nodeTransformFs } from '../src/transform-script-fs.node.ts';

beforeAll(() => { setTransformFs(nodeTransformFs); });
afterAll(() => { setTransformFs(null); });

function makeCard(id: string, taskId: string, front: string): AnkiCard {
  return {
    id, front, back: 'answer', text: null, tags: ['seed'], images: [], task_id: taskId,
    is_error_card: false, error_content: null, created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z', extra_fields: {}, template_id: null,
  };
}

interface Harness {
  executor: ChatAnkiExecutor;
  repo: CardStoreDouble;
  blocks: ChatBlockStoreDouble;
  chunks: Array<{ blockId: string; patch: Record<string, unknown> }>;
  events: Array<{ event: string; payload: unknown }>;
  call: ToolCall;
  run(args: Record<string, unknown>, overrides?: Partial<ToolExecutionContext>): Promise<ToolResultInfo>;
}

function harness(args: Record<string, unknown>, options: {
  nativeRegex?: boolean;
  tempRoot?: string | null;
  sandbox?: TransformSandboxBackend | null;
} = {}): Harness {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-transform', 'session-transform');
  const card = makeCard('card-transform', taskId, 'cat');
  expect(repo.insertCard(card)).toBe(true);
  const blocks = new ChatBlockStoreDouble();
  blocks.seedAnkiCardsBlock(
    'block-transform', 'session-transform', 'doc-transform', {}, [], [],
  );
  const chunks: Harness['chunks'] = [];
  const events: Harness['events'] = [];
  const executor = new ChatAnkiExecutor();
  const call: ToolCall = { id: 'call-transform', name: 'chatanki_transform', arguments: args };
  const base: ToolExecutionContext = {
    sessionId: 'session-transform', messageId: 'msg-transform', blockId: 'block-transform',
    cards: repo, documents: repo, chatBlocks: blocks,
    nativeRegexAsync: options.nativeRegex === false ? null : nativeRegexEngine,
    transformTempRoot: options.tempRoot ?? null,
    transformSandbox: options.sandbox ?? null,
    runId: 'run-transform',
    emitChunk: (blockId, patch) => { chunks.push({ blockId, patch }); },
    emitEvent: (event, payload) => { events.push({ event, payload }); },
    emitToolCallStart: () => undefined,
    emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined,
    saveToolBlock: () => undefined,
    warn: () => undefined,
  };
  return {
    executor, repo, blocks, chunks, events, call,
    run: (nextArgs, overrides) => executor.execute(
      { ...call, arguments: nextArgs },
      { ...base, ...overrides },
    ),
  };
}

const regexArgs = (mode: 'dry_run' | 'apply', expectedVersions?: Record<string, string>) => ({
  documentId: 'doc-transform',
  mode,
  transform: {
    ops: [{ op: 'regex_replace', field: 'front', pattern: 'cat', replacement: 'dog' }],
  },
  ...(expectedVersions === undefined ? {} : { expectedVersions }),
});

const tempRoots: string[] = [];
function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'chatanki-transform-exec-'));
  tempRoots.push(root);
  return root;
}
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('chatanki_transform executor wiring', () => {
  it('normalize_defaults_to_dry_run_and_default_live_selection (executor)', async () => {
    const h = harness(regexArgs('dry_run'));
    const result = await h.run(h.call.arguments as Record<string, unknown>);
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.status).toBe('ok');
    expect(output.mode).toBe('dry_run');
    expect(output.total).toBe(1);
    expect(output.changed).toBe(1);
    expect(output.mutationApplied).toBe(false);
    expect((output.diff as Array<Record<string, unknown>>)[0]?.after).toEqual({ front: 'dog' });
    expect(h.repo.getCardWithDocument('card-transform')?.card.front).toBe('cat');
    expect(h.blocks.getBlock('block-transform')?.toolOutput).toMatchObject({ cards: [] });
  });

  it('plan_transform_ops_produces_after_plans_in_selection_order (apply + ui sync)', async () => {
    const h = harness(regexArgs('apply', { 'card-transform': '2026-08-24T01:00:00Z' }));
    const result = await h.run(regexArgs('apply', { 'card-transform': '2026-08-24T01:00:00Z' }));
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.status).toBe('ok');
    expect(output.mode).toBe('apply');
    expect(output.updated).toBe(1);
    expect(output.mutationApplied).toBe(true);
    const updated = h.repo.getCardWithDocument('card-transform')?.card;
    expect(updated?.front).toBe('dog');
    const blockCards = (h.blocks.getBlock('block-transform')?.toolOutput as {
      cards: Array<Record<string, unknown>>;
    }).cards;
    expect(blockCards[0]?.front).toBe('dog');
    expect(h.chunks).toHaveLength(1);
    expect(h.chunks[0]?.blockId).toBe('block-transform');
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.event).toBe('fsrs://changed');
    expect(h.events[0]?.payload).toMatchObject({
      action: 'card_updated', entityIds: ['card-transform'], runId: 'run-transform',
    });
  });

  it('invalid_pattern_reports_op_index (executor)', async () => {
    const h = harness({
      documentId: 'doc-transform', mode: 'dry_run',
      transform: { ops: [{ op: 'regex_replace', field: 'front', pattern: '(', replacement: 'x' }] },
    });
    const result = await h.run(h.call.arguments as Record<string, unknown>);
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.status).toBe('blocked');
    expect(output.error).toBe('invalid_pattern');
    expect(output.opIndex).toBe(0);
    expect(output.mutationApplied).toBe(false);
    expect(h.repo.getCardWithDocument('card-transform')?.card.front).toBe('cat');
  });

  it('invalid_pattern_reports_op_index (missing nativeRegex is explicit)', async () => {
    const h = harness(regexArgs('dry_run'), { nativeRegex: false });
    const result = await h.run(h.call.arguments as Record<string, unknown>);
    expect(result.success).toBe(false);
    expect(result.error).toContain('F7 nativeRegex');
    expect(h.repo.getCardWithDocument('card-transform')?.card.front).toBe('cat');
  });

  it('normalize_script_mode_carries_language_code_and_default_timeout (headless rejection)', async () => {
    const h = harness({
      documentId: 'doc-transform', mode: 'dry_run',
      transform: { script: { language: 'python', code: 'print(1)' } },
    });
    const result = await h.run(h.call.arguments as Record<string, unknown>);
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.status).toBe('rejected');
    expect(output.error).toBe('script_environment_unavailable');
    expect(output.mutationApplied).toBe(false);
  });

  it('normalize_script_mode_propagates_script_contract_errors (missing sandbox backend)', async () => {
    const tempRoot = makeTempRoot();
    const h = harness({
      documentId: 'doc-transform', mode: 'dry_run',
      transform: { script: { language: 'python', code: 'print(1)' } },
    }, { tempRoot });
    const result = await h.run(h.call.arguments as Record<string, unknown>);
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.status).toBe('rejected');
    expect(output.error).toBe('script_sandbox_unavailable');
  });

  it('output_applies_field_updates_and_ignores_script_version (executor script meta)', async () => {
    const tempRoot = makeTempRoot();
    const outputCards = [{ id: 'card-transform', front: 'dog' }];
    const sandbox = writingSandbox(outputCards);
    const h = harness({
      documentId: 'doc-transform', mode: 'dry_run',
      transform: { script: { language: 'python', code: 'print(1)' } },
    }, { tempRoot, sandbox });
    const result = await h.run(h.call.arguments as Record<string, unknown>);
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.status).toBe('ok');
    expect(output.mode).toBe('dry_run');
    expect(output.changed).toBe(1);
    expect(output.jobPath).toMatch(/^runtime-root:\/\/temp\/chatanki_transform\/job-/);
    expect((output.script as Record<string, unknown>).exitCode).toBe(0);
    expect((output.diff as Array<Record<string, unknown>>)[0]?.after).toEqual({ front: 'dog' });
  });
});

function writingSandbox(cards: unknown): TransformSandboxBackend {
  const effects: TransformSandboxEffects = {
    backend: 'test',
    shellKind: 'posix_sh',
    outputEncoding: 'utf-8',
    enforced: true,
    networkEnforced: true,
    processGroupIsolated: true,
    cpuTimeLimitSeconds: 10,
    fileSizeLimitBytes: 8 * 1024 * 1024,
    activeProcessLimit: 8,
    readableRoots: 1,
    writableRoots: 1,
    protectedReadRoots: 0,
    protectedWriteRoots: 0,
  };
  return {
    capability: () => ({ available: true }),
    contract: () => ({ backend: 'test', shellKind: 'posix_sh', outputEncoding: 'utf-8' }),
    effectReport: () => effects,
    spawn: (request: TransformSandboxSpawnRequest): TransformSandboxProcess => {
      writeFileSync(request.env.CHATANKI_OUTPUT as string, JSON.stringify({ cards }), 'utf8');
      return {
        pid: 4242,
        stdout: null,
        stderr: null,
        wait: async () => 0,
        terminateProcessGroup: async () => undefined,
        cleanupFinishedProcessGroup: async () => undefined,
        cleanupResources: async () => undefined,
      };
    },
  };
}

it('hydrates the published L05 agentTransformSandbox and awaits async spawn', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'chatanki-transform-l05-'));
  const spawnCalls: TransformSandboxSpawnRequest[] = [];
  const effects: TransformSandboxEffects = {
    backend: 'l05-test',
    shellKind: 'posix_sh',
    outputEncoding: 'utf-8',
    enforced: true,
    networkEnforced: true,
    processGroupIsolated: true,
    cpuTimeLimitSeconds: 10,
    fileSizeLimitBytes: 8 * 1024 * 1024,
    activeProcessLimit: 8,
    readableRoots: 1,
    writableRoots: 1,
    protectedReadRoots: 0,
    protectedWriteRoots: 0,
  };
  const sandbox: TransformSandboxBackend = {
    capability: async () => ({ available: true }),
    contract: () => ({ backend: 'l05-test', shellKind: 'posix_sh', outputEncoding: 'utf-8' }),
    effectReport: () => effects,
    spawn: async (request) => {
      spawnCalls.push(request);
      writeFileSync(request.env.CHATANKI_OUTPUT as string, JSON.stringify({ cards: [] }), 'utf8');
      return {
        pid: 4242,
        stdout: null,
        stderr: null,
        wait: async () => 0,
        terminateProcessGroup: async () => undefined,
        cleanupFinishedProcessGroup: async () => undefined,
        cleanupResources: async () => undefined,
      };
    },
  };
  const host = await createTestHost({
    plugins: [chatanki],
    provide: {
      settings: { get: () => null, save: () => undefined },
      review: {},
      llm: {},
      anki: {},
      agentTransformSandbox: sandbox,
    },
  });
  try {
    const repo = new CardStoreDouble();
    const taskId = repo.seedDocument('doc-transform', 'session-transform');
    expect(repo.insertCard(makeCard('card-transform', taskId, 'cat'))).toBe(true);
    const result = await host.ctx.chatankiTools.execute(
      {
        id: 'call-transform-l05',
        name: 'chatanki_transform',
        arguments: {
          documentId: 'doc-transform',
          mode: 'dry_run',
          transform: { script: { language: 'node', code: 'process.exit(0)' } },
        },
      },
      {
        sessionId: 'session-transform', messageId: 'msg-transform', blockId: 'block-transform',
        cards: repo, transformTempRoot: tempRoot,
        emitToolCallStart: () => undefined,
        emitToolCallEnd: () => undefined,
        emitToolCallError: () => undefined,
        saveToolBlock: () => undefined,
        warn: () => undefined,
      },
    );
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.status).toBe('ok');
    expect((output.script as Record<string, unknown>).sandbox).toBe('l05-test');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.signal).toBeUndefined();
  } finally {
    await host.dispose();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
