import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
  BUDGET_SNAPSHOTS_TABLE, readSettingFromMainDb, SETTING_BUDGET_MAX_TOOL_CALLS,
  SETTING_BUDGET_MAX_TOKENS, SETTING_BUDGET_MAX_WALL_CLOCK_SECS,
} from '../repository/budget.ts';
import { setChatPipelineLocalFs } from '../src/local-fs.ts';
import { nodeChatPipelineLocalFs } from '../src/local-fs.node.ts';
import {
  DEFAULT_MAX_TOOL_CALLS, DEFAULT_MAX_TOKENS, DEFAULT_MAX_WALL_CLOCK_SECS,
  attachChildToTree, budgetExceededMessage, BudgetLedger, defaultBudgetLimits,
  ledgerForTree, ONE_TOOL_CALL, persistSnapshot, reserveChildSpec,
  resolveLimits, restoreBudgetLedgersFromDb, tokenDelta, treeKeyForSession, tryConsume,
  type BudgetLimits, type BudgetRemaining,
} from '../src/budget.ts';

// 主库 settings 探测走同步文件端口；单元测试直接装同一份 `node:fs` 实现（桌面入口注入）。
beforeAll(() => { setChatPipelineLocalFs(nodeChatPipelineLocalFs); });
afterAll(() => { setChatPipelineLocalFs(null); });

let storage: StorageServiceImpl | undefined;
let dir: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  storage?.dispose();
  storage = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function openStorage(): StorageServiceImpl {
  dir = fs.mkdtempSync(path.join(tmpdir(), 'chat-pipeline-budget-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  return storage;
}

function openDb(): DatabaseHandle {
  return openStorage().openFile(':memory:', { label: 'budget' });
}

function createSnapshotTable(db: DatabaseHandle): void {
  db.exec(`CREATE TABLE ${BUDGET_SNAPSHOTS_TABLE} (
    root_id TEXT PRIMARY KEY,
    limits_json TEXT NOT NULL,
    usage_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}

function smallLimits(maxToolCalls: number, maxTokens: number | bigint,
  maxWallClockSecs: number): BudgetLimits {
  return { maxToolCalls, maxTokens, maxWallClockSecs };
}

let keyCounter = 0;
function freshKey(tag: string): string {
  keyCounter += 1;
  return `tree_${tag}_${Date.now()}_${keyCounter}`;
}

function unwrap(result: ReturnType<BudgetLedger['tryConsume']>): BudgetRemaining {
  if (!result.ok) throw new Error(`unexpected budget rejection: ${result.exceeded.dimension}`);
  return result.remaining;
}

describe('chat_v2/budget.rs::tests', () => {
  it('snapshot_restore_preserves_exhaustion: P3 elapsed is monotonic while restart accounts for downtime', () => {
    let wall = 1_800_000_000_000;
    let mono = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    vi.spyOn(performance, 'now').mockImplementation(() => mono);
    const ledger = new BudgetLedger('monotonic-budget', smallLimits(100, 100, 10));
    expect(ledger.createdAtUnix).toBe(1_800_000_000);
    wall -= 100_000;
    mono += 2_000;
    expect(ledger.usage().wallClockSecs).toBe(2);
    wall += 1_000_000;
    expect(ledger.isExhausted()).toBe(false);
    mono += 8_001;
    expect(ledger.tryConsume(ONE_TOOL_CALL)).toEqual({ ok: false,
      exceeded: { dimension: 'wall_clock', used: 10, limit: 10 } });
    const restored = BudgetLedger.restored('monotonic-restored', smallLimits(100, 100, 2_000),
      { toolCalls: 1, tokensIn: 2, tokensOut: 3, wallClockSecs: 0 }, ledger.createdAtUnix);
    expect(restored.usage().wallClockSecs).toBe(900);
    wall -= 10_000_000;
    mono += 3_000;
    expect(restored.usage().wallClockSecs).toBe(903);
    expect(restored.usage().toolCalls).toBe(1);
  });
  it('settings_resolve_limits_valid_and_invalid', () => {
    // All missing → built-in defaults.
    expect(resolveLimits(() => null)).toEqual(defaultBudgetLimits());

    // Valid overrides.
    const limits = resolveLimits(key => {
      switch (key) {
        case SETTING_BUDGET_MAX_TOOL_CALLS: return '42';
        case SETTING_BUDGET_MAX_TOKENS: return '123456';
        case SETTING_BUDGET_MAX_WALL_CLOCK_SECS: return '90';
        default: return null;
      }
    });
    expect(limits.maxToolCalls).toBe(42);
    expect(limits.maxTokens).toBe(123_456);
    expect(limits.maxWallClockSecs).toBe(90);

    // Invalid values fall back one dimension at a time.
    for (const bad of ['abc', '0', '-5', '  ', '1.5']) {
      const invalid = resolveLimits(key =>
        key === SETTING_BUDGET_MAX_TOOL_CALLS ? bad : null);
      expect(invalid.maxToolCalls, `invalid value ${bad} must fall back`)
        .toBe(DEFAULT_MAX_TOOL_CALLS);
      expect(invalid.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    }

    // Whitespace-padded valid values parse.
    expect(resolveLimits(key => key === SETTING_BUDGET_MAX_TOKENS ? '  777  ' : null)
      .maxTokens).toBe(777);

    // Rust u64::from_str accepts an explicit plus sign.
    expect(resolveLimits(key => key === SETTING_BUDGET_MAX_TOOL_CALLS ? '+5' : null)
      .maxToolCalls).toBe(5);
    // Values above u64::MAX are a parse error, not a clamp.
    expect(resolveLimits(key => key === SETTING_BUDGET_MAX_TOOL_CALLS
      ? '18446744073709551616' : null).maxToolCalls).toBe(DEFAULT_MAX_TOOL_CALLS);
    expect(resolveLimits(key => key === SETTING_BUDGET_MAX_TOKENS
      ? '9007199254740993' : null).maxTokens).toBe(9_007_199_254_740_993n);
  });

  it('snapshot_persist_and_restore_roundtrip: preserves u64 above the JS safe range', () => {
    const db = openDb();
    createSnapshotTable(db);
    const root = 'root_u64_roundtrip';
    const maxTokens = 18_446_744_073_709_551_615n;
    const ledger = new BudgetLedger(root, { ...defaultBudgetLimits(), maxTokens });
    ledger.recordUsage({ toolCalls: 0, tokensIn: 9_007_199_254_740_993n, tokensOut: 2 });
    expect(ledger.remaining().tokens).toBe(maxTokens - 9_007_199_254_740_995n);
    persistSnapshot(db, ledger);
    const row = db.all<{ limits_json: string; usage_json: string }>(
      'SELECT limits_json, usage_json FROM budget_snapshots WHERE root_id = ?', [root])[0]!;
    expect(row.limits_json).toContain('"maxTokens":18446744073709551615');
    expect(row.usage_json).toContain('"tokensIn":9007199254740993');
    restoreBudgetLedgersFromDb(db);
    const restored = ledgerForTree(root)!;
    expect(restored.limits.maxTokens).toBe(maxTokens);
    expect(restored.usage().tokensIn).toBe(9_007_199_254_740_993n);
    expect(restored.tryConsume({ toolCalls: 0, tokensIn: 0, tokensOut: 3 }).ok).toBe(true);
    expect(restored.remaining().tokens).toBe(maxTokens - 9_007_199_254_740_998n);
    restored.recordUsage({ toolCalls: 0, tokensIn: maxTokens, tokensOut: 0 });
    expect(restored.usage().tokensIn).toBe(maxTokens);
    expect(restored.remaining().tokens).toBe(0);
  });

  it('settings_read_from_main_db_file', () => {
    const local = openStorage();
    const mainDbPath = path.join(dir!, 'mistakes.db');
    const conn = local.openFile(mainDbPath, { label: 'main-settings' });
    conn.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
      INSERT INTO settings (key, value, updated_at)
      VALUES ('headless_budget_max_tool_calls', '55', 't0'),
             ('headless_budget_max_tokens', 'not-a-number', 't0');`);

    local.close(conn);
    expect(readSettingFromMainDb(local, mainDbPath, SETTING_BUDGET_MAX_TOOL_CALLS)).toBe('55');
    // Invalid values come back untouched; the parser layer falls back.
    expect(readSettingFromMainDb(local, mainDbPath, SETTING_BUDGET_MAX_TOKENS)).toBe('not-a-number');
    expect(readSettingFromMainDb(local, mainDbPath, SETTING_BUDGET_MAX_WALL_CLOCK_SECS)).toBeNull();

    const missingPath = path.join(dir!, 'nope.db');
    expect(fs.existsSync(missingPath)).toBe(false);
    expect(readSettingFromMainDb(local, missingPath, SETTING_BUDGET_MAX_TOKENS)).toBeNull();
    expect(fs.existsSync(missingPath)).toBe(true);
    expect(readSettingFromMainDb(local, path.join(dir!, 'absent-parent', 'nope.db'), SETTING_BUDGET_MAX_TOKENS)).toBeNull();

    const limits = resolveLimits(key => readSettingFromMainDb(local, mainDbPath, key));
    expect(limits.maxToolCalls).toBe(55);
    expect(limits.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(limits.maxWallClockSecs).toBe(DEFAULT_MAX_WALL_CLOCK_SECS);
  });

  it('snapshot_persist_and_restore_roundtrip', () => {
    const db = openDb();
    createSnapshotTable(db);
    const root = freshKey('snap');
    const ledger = new BudgetLedger(root, smallLimits(100, 10_000, 3_600));
    unwrap(ledger.tryConsume(ONE_TOOL_CALL));
    ledger.recordUsage(tokenDelta(300, 200));
    persistSnapshot(db, ledger);
    const persisted = db.all<{ updated_at: string }>(
      'SELECT updated_at FROM budget_snapshots WHERE root_id = ?', [root]);
    // chrono AutoSi permits 0/3/6/9 fractional digits; F4 samples nanoseconds.
    expect(persisted[0]!.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.(?:\d{3}|\d{6}|\d{9}))?\+00:00$/);

    // "New process": restore into the global registry.
    restoreBudgetLedgersFromDb(db);
    const restored = ledgerForTree(root)!;
    expect(restored).not.toBeNull();
    expect(restored.usage().toolCalls).toBe(1);
    expect(restored.usage().tokensIn).toBe(300);
    expect(restored.usage().tokensOut).toBe(200);
    expect(restored.limits.maxToolCalls).toBe(100);
    expect(restored.limits.maxTokens).toBe(10_000);
    expect(restored.createdAtUnix).toBe(ledger.createdAtUnix);

    // Restored ledger keeps accumulating; restart never resets the budget.
    unwrap(restored.tryConsume(ONE_TOOL_CALL));
    expect(restored.usage().toolCalls).toBe(2);

    // Repeated restore is idempotent and never overwrites a live ledger.
    restoreBudgetLedgersFromDb(db);
    expect(ledgerForTree(root)!.usage().toolCalls).toBe(2);
  });

  it('snapshot_restore_preserves_exhaustion', () => {
    const db = openDb();
    createSnapshotTable(db);
    const rootTimeout = freshKey('timeout');
    const rootUsedUp = freshKey('usedup');
    const oldUnix = Math.floor(Date.now() / 1000) - 7_200;

    db.run(`INSERT INTO ${BUDGET_SNAPSHOTS_TABLE} (root_id, limits_json, usage_json, updated_at)
      VALUES (?, ?, ?, 't0')`, [rootTimeout, JSON.stringify({
      maxToolCalls: 1000, maxTokens: 10_000_000, maxWallClockSecs: 1800,
    }), JSON.stringify({
      toolCalls: 3, tokensIn: 100, tokensOut: 50, wallClockSecs: 1800,
      createdAtUnix: oldUnix,
    })]);
    db.run(`INSERT INTO ${BUDGET_SNAPSHOTS_TABLE} (root_id, limits_json, usage_json, updated_at)
      VALUES (?, ?, ?, 't0')`, [rootUsedUp, JSON.stringify({
      maxToolCalls: 5, maxTokens: 10_000_000, maxWallClockSecs: 86_400,
    }), JSON.stringify({
      toolCalls: 5, tokensIn: 0, tokensOut: 0, wallClockSecs: 10,
      createdAtUnix: Math.floor(Date.now() / 1000) - 10,
    })]);

    restoreBudgetLedgersFromDb(db);

    const timeoutLedger = ledgerForTree(rootTimeout)!;
    expect(timeoutLedger.isExhausted()).toBe(true);
    const timeoutResult = timeoutLedger.tryConsume(ONE_TOOL_CALL);
    expect(timeoutResult.ok).toBe(false);
    if (!timeoutResult.ok) expect(timeoutResult.exceeded.dimension).toBe('wall_clock');
    // Downtime keeps counting; restart does not reset elapsed time.
    expect(timeoutLedger.usage().wallClockSecs).toBeGreaterThanOrEqual(7_200);

    const usedUpLedger = ledgerForTree(rootUsedUp)!;
    expect(usedUpLedger.isExhausted()).toBe(true);
    expect(usedUpLedger.tryConsume(ONE_TOOL_CALL).ok).toBe(false);
  });

  it('snapshot_restore_tolerates_missing_table_and_bad_rows', () => {
    const dbNoTable = openDb();
    expect(() => restoreBudgetLedgersFromDb(dbNoTable)).not.toThrow();

    const db = openDb();
    createSnapshotTable(db);
    const goodRoot = freshKey('good');
    db.run(`INSERT INTO ${BUDGET_SNAPSHOTS_TABLE} (root_id, limits_json, usage_json, updated_at)
      VALUES ('root-bad-json', 'not json', '{}', 't0')`);
    db.run(`INSERT INTO ${BUDGET_SNAPSHOTS_TABLE} (root_id, limits_json, usage_json, updated_at)
      VALUES (?, ?, ?, 't0')`, [goodRoot, JSON.stringify({
      maxToolCalls: 9, maxTokens: 99, maxWallClockSecs: 999,
    }), JSON.stringify({
      toolCalls: 1, tokensIn: 2, tokensOut: 3, wallClockSecs: 4,
      createdAtUnix: Math.floor(Date.now() / 1000),
    })]);

    restoreBudgetLedgersFromDb(db);
    expect(ledgerForTree('root-bad-json')).toBeNull();
    const good = ledgerForTree(goodRoot)!;
    expect(good.usage().toolCalls).toBe(1);
    expect(good.limits.maxToolCalls).toBe(9);
  });

  it('tree_aggregation_parent_and_two_children_share_one_ledger', () => {
    const parent = freshKey('parent');
    const childA = freshKey('child_a');
    const childB = freshKey('child_b');

    const attachA = attachChildToTree(parent, childA);
    const attachB = attachChildToTree(parent, childB);

    expect(attachA.treeKey).toBe(parent);
    expect(attachB.treeKey).toBe(parent);
    expect(treeKeyForSession(childA)).toBe(parent);
    expect(treeKeyForSession(childB)).toBe(parent);

    // Parent-side consumption plus one call per child: all in one ledger.
    unwrap(tryConsume(attachA.treeKey, ONE_TOOL_CALL));
    unwrap(tryConsume(treeKeyForSession(childA)!, ONE_TOOL_CALL));
    unwrap(tryConsume(treeKeyForSession(childB)!, ONE_TOOL_CALL));

    const ledger = ledgerForTree(parent)!;
    expect(ledger.usage().toolCalls).toBe(3);
    expect(ledger.activeBindings()).toBe(2);

    attachA.release();
    attachB.release();
    expect(treeKeyForSession(childA)).toBeNull();
    expect(treeKeyForSession(childB)).toBeNull();
  });

  it('grandchild_rolls_up_to_same_root', () => {
    const rootParent = freshKey('root');
    const worker = freshKey('worker');
    const grandchild = freshKey('grandchild');

    const attachWorker = attachChildToTree(rootParent, worker);
    const attachGrandchild = attachChildToTree(worker, grandchild);

    expect(attachGrandchild.treeKey).toBe(attachWorker.treeKey);
    unwrap(tryConsume(treeKeyForSession(grandchild)!, ONE_TOOL_CALL));
    expect(ledgerForTree(attachWorker.treeKey)!.usage().toolCalls).toBe(1);
  });

  it('exceed_blocks_without_going_negative', () => {
    const ledger = new BudgetLedger(freshKey('cap'), smallLimits(2, 10, 60));
    expect(ledger.tryConsume(ONE_TOOL_CALL).ok).toBe(true);
    expect(ledger.tryConsume(ONE_TOOL_CALL).ok).toBe(true);
    const err = ledger.tryConsume(ONE_TOOL_CALL);
    expect(err.ok).toBe(false);
    if (!err.ok) {
      expect(err.exceeded.dimension).toBe('tool_calls');
      expect(err.exceeded.used).toBe(2);
      expect(err.exceeded.limit).toBe(2);
    }
    // A rejection consumes nothing.
    expect(ledger.usage().toolCalls).toBe(2);
    expect(ledger.remaining().toolCalls).toBe(0);

    // Tokens are all-or-nothing as well.
    const tokenLedger = new BudgetLedger(freshKey('tok'), smallLimits(100, 10, 60));
    const tokenErr = tokenLedger.tryConsume(tokenDelta(8, 8));
    expect(tokenErr.ok).toBe(false);
    if (!tokenErr.ok) expect(tokenErr.exceeded.dimension).toBe('tokens');
    expect(tokenLedger.usage().tokensIn).toBe(0);
    expect(tokenLedger.usage().tokensOut).toBe(0);

    // recordUsage may overshoot; the next gate rejects.
    const remaining = tokenLedger.recordUsage(tokenDelta(7, 6));
    expect(BigInt(tokenLedger.usage().tokensIn) + BigInt(tokenLedger.usage().tokensOut)).toBe(13n);
    expect(remaining.tokens).toBe(0);
    expect(tokenLedger.tryConsume(ONE_TOOL_CALL).ok).toBe(false);

    // Wall clock exhausted immediately when the limit is zero.
    let nowMs = 1_000;
    const wallLedger = new BudgetLedger(freshKey('wc'), smallLimits(100, 100, 0),
      () => nowMs);
    nowMs += 1;
    const wallErr = wallLedger.tryConsume(ONE_TOOL_CALL);
    expect(wallErr.ok).toBe(false);
    if (!wallErr.ok) expect(wallErr.exceeded.dimension).toBe('wall_clock');
    expect(wallLedger.isExhausted()).toBe(true);
  });

  it('reserve_shrinks_child_cap_when_parent_low', () => {
    const remaining: BudgetRemaining = { toolCalls: 50, tokens: 100_000, wallClockSecs: 600 };
    const declared = { maxToolCalls: 80, maxTokens: 500_000, maxWallClockSeconds: 300 };
    const effective = reserveChildSpec(declared, remaining);
    expect(effective.maxToolCalls).toBe(50);
    expect(effective.maxTokens).toBe(100_000);
    expect(effective.maxWallClockSeconds).toBe(300);

    const inherited = reserveChildSpec(null, remaining);
    expect(inherited.maxToolCalls).toBe(50);
    expect(inherited.maxTokens).toBe(100_000);
    expect(inherited.maxWallClockSeconds).toBe(600);

    const huge: BudgetRemaining = {
      toolCalls: 18_446_744_073_709_551_615n, tokens: 18_446_744_073_709_551_615n,
      wallClockSecs: 18_446_744_073_709_551_615n,
    };
    const small = reserveChildSpec({ maxToolCalls: 7, maxTokens: null,
      maxWallClockSeconds: null }, huge);
    expect(small.maxToolCalls).toBe(7);
    expect(small.maxTokens).toBe(18_446_744_073_709_551_615n);
    expect(small.maxWallClockSeconds).toBe(18_446_744_073_709_551_615n);
    expect(reserveChildSpec(null, huge).maxToolCalls).toBe(0xffff_ffff);
  });

  it('sub_calls_accounted_into_tree', () => {
    const parent = freshKey('parent');
    const worker = freshKey('worker');
    const attach = attachChildToTree(parent, worker);

    const consumeAsGate = (session: string, count: number): void => {
      const key = treeKeyForSession(session)!;
      for (let index = 0; index < count; index++) unwrap(tryConsume(key, ONE_TOOL_CALL));
    };
    // Worker itself + tool_pack sub-calls + ptc sub-calls share the session id.
    consumeAsGate(worker, 1);
    consumeAsGate(worker, 3);
    consumeAsGate(worker, 2);

    expect(ledgerForTree(attach.treeKey)!.usage().toolCalls).toBe(6);
  });

  it('concurrent_consume_is_race_free', async () => {
    const threads = 8;
    const perThread = 50;
    const limit = 200;
    const ledger = new BudgetLedger(freshKey('race'), smallLimits(limit,
      18_446_744_073_709_551_615n, 3_600));
    let successes = 0;

    await Promise.all(Array.from({ length: threads }, async () => {
      for (let index = 0; index < perThread; index++) {
        if (ledger.tryConsume(ONE_TOOL_CALL).ok) successes += 1;
        // Yield so the counter updates interleave across tasks.
        await Promise.resolve();
      }
    }));

    expect(successes).toBe(limit);
    expect(ledger.usage().toolCalls).toBe(limit);
    expect(ledger.remaining().toolCalls).toBe(0);
    expect(ledger.tryConsume(ONE_TOOL_CALL).ok).toBe(false);
    expect(ledger.usage().toolCalls).toBe(limit);
  });

  it('binding_guard_respects_generation', () => {
    const parent = freshKey('parent');
    const worker = freshKey('worker');

    const attach1 = attachChildToTree(parent, worker);
    const attach2 = attachChildToTree(parent, worker);
    expect(attach1.treeKey).toBe(attach2.treeKey);
    const ledger = ledgerForTree(parent)!;
    expect(ledger.activeBindings()).toBe(2);

    // Old generation must not remove the newer binding.
    attach1.release();
    expect(treeKeyForSession(worker)).toBe(parent);
    expect(ledger.activeBindings()).toBe(1);

    // Current generation releases normally.
    attach2.binding.release();
    expect(treeKeyForSession(worker)).toBeNull();
    expect(ledger.activeBindings()).toBe(0);
  });

  it('exhausted_and_idle_ledger_rotates_on_next_attach', () => {
    const parent = freshKey('parent');
    const child1 = freshKey('child1');
    const attach1 = attachChildToTree(parent, child1);
    const ledger1 = ledgerForTree(parent)!;
    for (let index = 0; index < DEFAULT_MAX_TOOL_CALLS; index++) {
      unwrap(ledger1.tryConsume(ONE_TOOL_CALL));
    }
    expect(ledger1.isExhausted()).toBe(true);

    // Tree still has a live binding → no rotation.
    const child2 = freshKey('child2');
    const attach2 = attachChildToTree(parent, child2);
    expect(ledgerForTree(parent)).toBe(ledger1);
    const key2 = treeKeyForSession(child2)!;
    expect(tryConsume(key2, ONE_TOOL_CALL).ok).toBe(false);

    attach1.release();
    attach2.release();
    expect(ledger1.activeBindings()).toBe(0);

    // Exhausted + idle tree rotates: a fresh ledger starts from zero.
    const child3 = freshKey('child3');
    const attach3 = attachChildToTree(parent, child3);
    const ledger3 = ledgerForTree(parent)!;
    expect(ledger3).not.toBe(ledger1);
    expect(ledger3.usage().toolCalls).toBe(0);
    expect(tryConsume(treeKeyForSession(child3)!, ONE_TOOL_CALL).ok).toBe(true);
    attach3.release();
  });

  it('exceeded_message_is_explicit', () => {
    const message = budgetExceededMessage({ dimension: 'tool_calls', used: 200, limit: 200 },
      'builtin-web_search');
    expect(message).toContain('任务树预算已耗尽');
    expect(message).toContain('200 / 上限 200');
    expect(message).toContain('builtin-web_search');
    expect(message).toContain('最终回答');
    expect(budgetExceededMessage({ dimension: 'wall_clock', used: 1801, limit: 1800 }, 't'))
      .toContain('运行时长');
  });
});
