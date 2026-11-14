import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { parseRfc3339 } from '../../../platform/time/index.ts';
import plugin from '../index.ts';
import {
  ChatV2Error, newPendingPlan, bindPlanToCall, markPlanApproved, markPlanExpired,
  isPlanBatchActive, isPlanActiveForBinding, type ChatSessionService, type PlanAuthorityState,
} from '../api.ts';
import { newSession } from '../src/types.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';

const instant = parseRfc3339('2026-11-06T12:00:00.123456789Z')!;
const approved = (): PlanAuthorityState => ({ planId: 'plan_test', status: 'approved', summary: 'write',
  bindingKey: 'binding', approvedUntil: '2026-11-06T12:00:00.123456790Z' });

describe('WP-168 repo.rs/types.rs authority through real ctx.chatSession', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let service: ChatSessionService;
  const id = 'sess_authority';
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    service = host.ctx.chatSession;
    service.createSession({ ...newSession(id, 'chat'), updatedAt: '2020-01-01T00:00:00Z' });
  });
  afterEach(async () => { vi.restoreAllMocks(); await host.dispose(); f.dispose(); });
  function metadata(value: unknown) {
    f.db.run('UPDATE chat_v2_sessions SET metadata_json = ? WHERE id = ?', [JSON.stringify(value), id]);
  }
  function row() {
    return f.db.one<{ metadata_json: string | null; updated_at: string }>(
      'SELECT metadata_json, updated_at FROM chat_v2_sessions WHERE id = ?', [id]);
  }

  it('missing sessions retain SessionNotFound and release the transaction', () => {
    for (const call of [() => service.getSessionAuthorityState('absent'),
      () => service.setSessionPlanState('absent', null),
      () => service.consumeSessionPlanBinding('absent', 'binding', instant)]) {
      expect(call).toThrow(new ChatV2Error('SessionNotFound', 'absent'));
    }
    expect(f.db.inTransaction).toBe(false);
    expect(service.getSessionAuthorityState(id)).toEqual({ authorityMode: 'craft', permissionPreset: 'relaxed' });
  });

  it('metadata aliases use key presence, Rust trim/ASCII case, defaults and typed plan fallback', () => {
    for (const value of [null, [], 'text', 7, {}]) {
      metadata(value);
      expect(service.getSessionAuthorityState(id)).toEqual({ authorityMode: 'craft', permissionPreset: 'relaxed' });
    }
    metadata({ authority_mode: '\u0085PLAN\u0085', permission_preset: ' FULL_ACCESS ', plan: approved() });
    expect(service.getSessionAuthorityState(id)).toEqual({ authorityMode: 'plan', permissionPreset: 'full_access', plan: approved() });
    metadata({ authorityMode: null, authority_mode: 'plan', permissionPreset: 1, permission_preset: 'full_access' });
    expect(service.getSessionAuthorityState(id)).toEqual({ authorityMode: 'craft', permissionPreset: 'relaxed' });
    for (const plan of [null, {}, { ...approved(), status: null }, { ...approved(), summary: 1 },
      { ...approved(), approvedAt: false }, { ...approved(), bindingKey: 3 }, { ...approved(), status: 'Approved' }]) {
      metadata({ authorityMode: 'plan', plan });
      expect(service.getSessionAuthorityState(id)).toEqual({ authorityMode: 'plan', permissionPreset: 'relaxed' });
    }
    metadata({ authorityMode: '\uFEFFplan', permissionPreset: 'RELAXED', plan: {
      planId: 'p', status: { approved: null }, summary: '', approvedAt: null, extra: true,
    } });
    expect(service.getSessionAuthorityState(id)).toEqual({ authorityMode: 'craft', permissionPreset: 'relaxed',
      plan: { planId: 'p', status: 'approved', summary: '' } });
    metadata({ plan: ['p', 'pending', 'summary'] });
    expect(service.getSessionAuthorityState(id).plan).toEqual({ planId: 'p', status: 'pending', summary: 'summary' });
    for (const raw of ['{bad', '{"plan":null,}', '1e999']) {
      f.db.run('UPDATE chat_v2_sessions SET metadata_json = ? WHERE id = ?', [raw, id]);
      expect(service.getSessionAuthorityState(id)).toEqual({ authorityMode: 'craft', permissionPreset: 'relaxed' });
      expect(service.setSessionPlanState(id, null).metadata).toEqual({ authorityMode: 'craft', authority_mode: 'craft',
        permissionPreset: 'relaxed', permission_preset: 'relaxed' });
    }
    f.db.run('UPDATE chat_v2_sessions SET metadata_json = ? WHERE id = ?', [
      '{"authorityMode":"ask","authorityMode":"plan","plan":{"planId":"p","summary":"s","status":"pending","status":"approved"}}', id]);
    expect(service.getSessionAuthorityState(id)).toEqual({ authorityMode: 'plan', permissionPreset: 'relaxed',
      plan: { planId: 'p', summary: 's', status: 'approved' } });
    expect(service.consumeSessionPlanBinding(id, 'binding', instant)).toBe(false);
    service.setSessionPlanState(id, { planId: 'p', summary: 's', status: 'approved', bindingKey: 'binding' });
    expect(service.consumeSessionPlanBinding(id, 'binding', instant)).toBe(true);
  });

  it('set plan preserves metadata and session fields, writes both aliases, samples updatedAt after read', () => {
    f.db.run('UPDATE chat_v2_sessions SET metadata_json = ? WHERE id = ?', [
      '{"authority_mode":"plan","permission_preset":"cautious","other":{"n":9007199254740993,"huge":1e999,"nil":null}}', id]);
    const before = service.getSession(id)!;
    const read = f.db.get.bind(f.db);
    const order: string[] = [];
    vi.spyOn(f.db, 'get').mockImplementation((...args: Parameters<typeof f.db.get>) => {
      order.push('read'); return read(...args);
    });
    vi.spyOn(Date, 'now').mockImplementation(() => { order.push('clock'); return 1793966400000; });
    const result = service.setSessionPlanState(id, approved());
    expect(order[0]).toBe('read');
    expect(order).toContain('clock');
    expect(result).toEqual({ ...before, updatedAt: result.updatedAt, metadata: {
      ...(before.metadata as object), authorityMode: 'plan', permissionPreset: 'cautious', plan: approved(),
    } });
    expect(parseRfc3339(result.updatedAt)!.epochNanos).toBeGreaterThan(parseRfc3339(before.updatedAt)!.epochNanos);
    expect(row().metadata_json).toContain('9007199254740993');
    expect(row().metadata_json).toContain('1e+999');
    expect(row().updated_at).toBe(result.updatedAt.replace('Z', '+00:00'));
    const cleared = service.setSessionPlanState(id, null);
    expect(cleared.metadata).not.toHaveProperty('plan');
    expect(row().metadata_json).toContain('9007199254740993');
  });

  it('Plan value operations keep IDs, bindings, TTL precision and strict expiry', () => {
    const plan = newPendingPlan('summary');
    expect(plan).toEqual({ planId: expect.stringMatching(/^plan_[0-9a-f-]{36}$/), status: 'pending', summary: 'summary' });
    expect(newPendingPlan('summary').planId).not.toBe(plan.planId);
    expect(isPlanBatchActive(plan, instant)).toBe(false);
    bindPlanToCall(plan, 'binding');
    markPlanApproved(plan, 600n);
    expect(plan.status).toBe('approved');
    expect(plan.bindingKey).toBe('binding');
    expect(parseRfc3339(plan.approvedUntil!)!.epochNanos - parseRfc3339(plan.approvedAt!)!.epochNanos).toBe(600_000_000_000n);
    expect(plan.approvedAt).toMatch(/\+00:00$/);
    expect(isPlanActiveForBinding(plan, 'binding', parseRfc3339(plan.approvedAt!)!)).toBe(true);
    expect(isPlanActiveForBinding(plan, 'wrong', instant)).toBe(false);
    expect(isPlanActiveForBinding(approved(), 'binding', instant)).toBe(true);
    expect(isPlanBatchActive(approved(), parseRfc3339(approved().approvedUntil!)!)).toBe(false);
    expect(isPlanBatchActive({ ...approved(), approvedUntil: 'bad' }, instant)).toBe(false);
    expect(isPlanBatchActive({ ...approved(), approvedUntil: undefined }, instant)).toBe(true);
    expect(isPlanActiveForBinding({ ...approved(), bindingKey: undefined }, 'binding', instant)).toBe(false);
    markPlanExpired(plan);
    expect(plan.status).toBe('expired');
    expect(plan.bindingKey).toBe('binding');
    expect(isPlanBatchActive(plan, instant)).toBe(false);
    markPlanApproved(plan, -1n);
    expect(isPlanBatchActive(plan, parseRfc3339(plan.approvedAt!)!)).toBe(false);
    expect(() => markPlanApproved(plan, 9223372036854776n)).toThrow('TimeDelta::seconds out of bounds');
    expect(() => markPlanApproved(plan, -9223372036854776n)).toThrow('TimeDelta::seconds out of bounds');
    expect(() => markPlanApproved(plan, 9223372036854775n)).toThrow('`DateTime + TimeDelta` overflowed');
    // chrono orders the base second before nanoseconds, not normalized Unix nanos.
    const leap = { ...approved(), approvedUntil: '2016-12-31T23:59:60.5Z' };
    expect(isPlanBatchActive(leap, parseRfc3339('2017-01-01T00:00:00Z')!)).toBe(false);
    expect(isPlanBatchActive(leap, parseRfc3339('2016-12-31T23:59:60.499999999Z')!)).toBe(true);
  });

  it('consume checks mode/status/binding/expiry and commits mismatches without changing the row', () => {
    const transaction = f.db.transaction.bind(f.db);
    let commits = 0;
    vi.spyOn(f.db, 'transaction').mockImplementation((fn, options) => {
      expect(options).toEqual({ behavior: 'immediate' });
      return transaction(tx => { tx.afterCommit(() => { commits++; }); return fn(tx); }, options);
    });
    const cases = [
      { authorityMode: 'craft', plan: approved() }, { authorityMode: 'ask', plan: approved() },
      { authorityMode: 'plan' }, ...['pending', 'rejected', 'expired'].map(status => ({ authorityMode: 'plan', plan: { ...approved(), status } })),
      { authorityMode: 'plan', plan: { ...approved(), bindingKey: 'wrong' } },
      { authorityMode: 'plan', plan: { ...approved(), bindingKey: undefined } },
      { authorityMode: 'plan', plan: { ...approved(), approvedUntil: '2026-11-06T12:00:00.123456789Z' } },
      { authorityMode: 'plan', plan: { ...approved(), approvedUntil: 'invalid' } },
    ];
    for (const value of cases) {
      metadata(value); const before = row();
      expect(service.consumeSessionPlanBinding(id, 'binding', instant)).toBe(false);
      expect(row()).toEqual(before);
    }
    expect(commits).toBe(cases.length);
  });

  it('consume rereads under the SQLite IMMEDIATE write lock and persists only one successful consumption', () => {
    metadata({ authority_mode: 'plan', permission_preset: 'full_access', keep: [1, null], plan: approved() });
    const other = f.storage.openFile(service.database.dbPath(), { profile: { busyTimeoutMs: 0 } });
    const transaction = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, 'transaction').mockImplementation((fn, options) => transaction(tx => {
      expect(tx.inTransaction).toBe(true);
      expect(() => other.run('UPDATE chat_v2_sessions SET title = ? WHERE id = ?', ['competing', id])).toThrow('database is locked');
      // The authority snapshot must be read inside the transaction, after this change.
      tx.run('UPDATE chat_v2_sessions SET title = ? WHERE id = ?', ['inside', id]);
      return fn(tx);
    }, options));
    try {
      expect(service.consumeSessionPlanBinding(id, 'binding', instant)).toBe(true);
      expect(service.getSession(id)!.title).toBe('inside');
      expect(service.getSession(id)!.metadata).toEqual({ authority_mode: 'plan', permission_preset: 'full_access',
        authorityMode: 'plan', permissionPreset: 'full_access', keep: [1, null] });
      expect(service.getSession(id)!.updatedAt).not.toBe('2020-01-01T00:00:00Z');
      expect(service.consumeSessionPlanBinding(id, 'binding', instant)).toBe(false);
      expect(other.inTransaction).toBe(false);
    } finally { f.storage.close(other); }
  });

  it('SQL update failure rolls back plan and updatedAt, and retry succeeds', () => {
    metadata({ authorityMode: 'plan', plan: approved() });
    const before = row();
    f.db.exec("CREATE TRIGGER reject_plan BEFORE UPDATE ON chat_v2_sessions BEGIN SELECT RAISE(ABORT, 'plan write failed'); END");
    expect(() => service.consumeSessionPlanBinding(id, 'binding', instant)).toThrow(new ChatV2Error('Database', 'plan write failed'));
    expect(row()).toEqual(before);
    expect(f.db.inTransaction).toBe(false);
    expect(() => service.setSessionPlanState(id, null)).toThrow(new ChatV2Error('Database', 'plan write failed'));
    expect(row()).toEqual(before);
    f.db.exec('DROP TRIGGER reject_plan');
    expect(service.consumeSessionPlanBinding(id, 'binding', instant)).toBe(true);
  });

  it('SQL COMMIT failure rolls back all writes and keeps the approval available', () => {
    metadata({ authorityMode: 'plan', plan: approved() });
    const before = row();
    const logs: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { logs.push(`${message.type}:${String(message.args[0])}`); } });
    f.db.exec(`CREATE TABLE plan_commit_probe (session_id TEXT REFERENCES chat_v2_sessions(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_plan_commit AFTER UPDATE ON chat_v2_sessions BEGIN INSERT INTO plan_commit_probe VALUES ('absent'); END;`);
    expect(() => service.consumeSessionPlanBinding(id, 'binding', instant)).toThrow(new ChatV2Error('Database', 'FOREIGN KEY constraint failed'));
    expect(row()).toEqual(before);
    expect(f.db.pluck('SELECT COUNT(*) FROM plan_commit_probe')).toBe(0);
    expect(f.db.inTransaction).toBe(false);
    // Rust update_session logs success before the enclosing transaction commits.
    expect(logs).toContain(`debug:[ChatV2::Repo] Updating session: ${id}`);
    expect(logs).toContain(`info:[ChatV2::Repo] Session updated: ${id}`);
    f.db.exec('DROP TRIGGER fail_plan_commit');
    expect(service.consumeSessionPlanBinding(id, 'binding', instant)).toBe(true);
  });

  it('two independent Host processes compete on real SQLite: exactly one returns true', async () => {
    metadata({ authorityMode: 'plan', keep: 'concurrent', plan: approved() });
    const children: ChildProcess[] = [];
    try {
      const contenders = [0, 1].map(() => {
        const child = fork(fileURLToPath(new URL('./session-authority-worker.mjs', import.meta.url)),
          [f.root, id], { execArgv: ['--experimental-strip-types'], silent: true });
        children.push(child);
        let output = '';
        child.stderr!.on('data', chunk => { output += String(chunk); });
        const ready = new Promise<void>((resolve, reject) => {
          child.on('message', message => { if (message === 'ready') resolve(); });
          child.once('error', reject);
          child.once('exit', code => { if (code !== 0) reject(new Error(output)); });
        });
        const result = new Promise<boolean>((resolve, reject) => {
          let value: boolean | undefined;
          child.on('message', message => { if (typeof message === 'boolean') value = message; });
          child.once('error', reject);
          child.once('exit', code => code === 0 && value !== undefined ? resolve(value) : reject(new Error(output)));
        });
        return { child, ready, result };
      });
      await Promise.all(contenders.map(item => item.ready));
      for (const item of contenders) item.child.send('consume');
      expect((await Promise.all(contenders.map(item => item.result))).sort()).toEqual([false, true]);
      expect(service.getSessionAuthorityState(id)).toEqual({ authorityMode: 'plan', permissionPreset: 'relaxed' });
      expect(service.getSession(id)!.metadata).toHaveProperty('keep', 'concurrent');
    } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
  });
});
