import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import pipeline from '../../chat-pipeline/index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';
import { ChatV2Error, saveSessionStateWithConn } from '../api.ts';
import type { CompactionOutcome } from '../../chat-pipeline/api.ts';
import type { CompactionPipelinePort } from '../src/compaction-actions.ts';

describe('X5-01 compact command production registration contract', () => {
  let helperFixture: ReturnType<typeof databaseFixture>;
  let helpers: Awaited<ReturnType<typeof createTestHost>>;
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let outcome: CompactionOutcome;
  let run: CompactionPipelinePort['runCompactionForSession'];
  const calls: Parameters<CompactionPipelinePort['runCompactionForSession']>[] = [];
  beforeAll(async () => {
    helperFixture = databaseFixture();
    helpers = await createTestHost({ plugins: [plugin, pipeline], provide: {
      storage: helperFixture.storage, vfs: vfsStub, settings: {}, nativeTokenizer: {}, vfsRepo: {}, agentVfsResolver: {},
    } });
  });
  afterAll(async () => { await helpers.dispose(); helperFixture.dispose(); });
  beforeEach(async () => {
    f = databaseFixture(); calls.length = 0;
    outcome = { kind: 'compacted', tokensBefore: 100, tokensAfter: 30 };
    run = async (...args) => { calls.push(args); return outcome; };
    const real = helpers.ctx.chatPipeline;
    const port: CompactionPipelinePort = {
      runCompactionForSession: (...args) => run(...args),
      compactionStatus: value => real.compactionStatus(value),
      compactionReasonCode: value => real.compactionReasonCode(value),
      compactionTokenEstimates: value => real.compactionTokenEstimates(value),
    };
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub, chatPipeline: port } });
    host.ctx.chatSession.createSession(newSession('sess_compact_command', 'chat'));
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });
  const args = { sessionId: 'sess_compact_command', modelConfigId: '\u0085model_explicit\u0085', contextLimit: 0 };

  it('does not register a fixed-failure command when the supplied provider has helpers only', async () => {
    const real = helpers.ctx.chatPipeline;
    const helperOnly = await createTestHost({ plugins: [plugin], provide: {
      storage: f.storage, vfs: vfsStub, chatPipeline: {
        compactionStatus: value => real.compactionStatus(value),
        compactionReasonCode: value => real.compactionReasonCode(value),
        compactionTokenEstimates: value => real.compactionTokenEstimates(value),
      } satisfies Pick<CompactionPipelinePort, 'compactionStatus' | 'compactionReasonCode' | 'compactionTokenEstimates'>,
    } });
    try { await expect(helperOnly.invoke('chat_v2_compact_session', args)).rejects.toContain('Command not found'); }
    finally { await helperOnly.dispose(); }
  });
  it('passes explicit model, zero context and persisted false memory without inventing options', async () => {
    saveSessionStateWithConn(f.db, args.sessionId, { sessionId: args.sessionId, updatedAt: '', features: { userMemory: false } });
    expect(await host.invoke('chat_v2_compact_session', args)).toEqual({ status: 'compacted', reason: null, tokensBefore: 100, tokensAfter: 30 });
    expect(calls[0]?.slice(0, 6)).toEqual([args.sessionId, 'model_explicit', 'manual', [], 0, false]);
    expect(calls[0]?.[6]).toBeInstanceOf(AbortSignal);
    expect(host.ctx.chatState.hasActiveStream(args.sessionId)).toBe(false);
  });
  it('uses None memory for an unreadable or invalid typed feature map and omits absent token estimates', async () => {
    saveSessionStateWithConn(f.db, args.sessionId, { sessionId: args.sessionId, updatedAt: '' });
    f.db.run('UPDATE chat_v2_session_state SET features_json = ?', ['{"userMemory":false,"other":"invalid"}']);
    outcome = { kind: 'failed', reason: 'summaryFailed' };
    expect(await host.invoke('chat_v2_compact_session', args)).toEqual({ status: 'failed', reason: 'summaryFailed' });
    expect(calls[0]?.[5]).toBeNull();
    f.db.exec('DROP TABLE chat_v2_session_state');
    outcome = { kind: 'notNeeded', reason: 'sessionTooShort' };
    expect(await host.invoke('chat_v2_compact_session', args)).toEqual({ status: 'notNeeded', reason: 'sessionTooShort' });
    expect(calls[1]?.[5]).toBeNull();
  });
  it('validates writable before model and returns structured streaming on admission rejection', async () => {
    const session = host.ctx.chatSession.getSession(args.sessionId)!;
    host.ctx.chatSession.updateSession({ ...session, mode: 'subagent' });
    await expect(host.invoke('chat_v2_compact_session', { ...args, modelConfigId: '' })).rejects.toContain('Subagent sessions are read-only');
    host.ctx.chatSession.updateSession(session);
    await expect(host.invoke('chat_v2_compact_session', { ...args, modelConfigId: '\u0085' })).rejects.toBe(new ChatV2Error('Validation', 'modelConfigId is required').toCommandError());
    host.ctx.chatState.registerStream(args.sessionId);
    expect(await host.invoke('chat_v2_compact_session', args)).toEqual({ status: 'skipped', reason: 'streaming' });
    host.ctx.chatState.cancelStream(args.sessionId); host.ctx.chatState.killSwitch.trip('stop');
    expect(await host.invoke('chat_v2_compact_session', args)).toEqual({ status: 'skipped', reason: 'streaming' });
    expect(calls).toHaveLength(0);
  });
  it('awaits execution and cannot remove the retry generation on hard failure', async () => {
    let resolve!: (value: CompactionOutcome) => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<CompactionOutcome>((done, fail) => { resolve = done; reject = fail; });
    run = async () => pending;
    const result = host.invoke('chat_v2_compact_session', args);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(host.ctx.chatState.hasActiveStream(args.sessionId)).toBe(true);
      host.ctx.chatState.cancelStream(args.sessionId);
      const retry = host.ctx.chatState.tryRegisterStreamOwned(args.sessionId)!;
      reject(new ChatV2Error('Database', 'commit failed'));
      await expect(result).rejects.toBe(new ChatV2Error('Database', 'commit failed').toCommandError());
      expect(host.ctx.chatState.registrationGeneration(args.sessionId)).toBe(retry.generation);
    } finally { resolve(outcome); }
  });
});
