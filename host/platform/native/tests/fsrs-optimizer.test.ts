import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readZip } from '../../util/node.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';
import { DEFAULT_PARAMETERS, FsrsError, type FsrsItem, type FsrsNextStates } from '../fsrs/api.ts';
import { holdNextWasmRun, removeRun, runWasm, WasmCancelledError } from '../wasm/loader.ts';

/**
 * fsrs =6.6.2 `compute_parameters` / `FSRS::evaluate` through `ctx.nativeFsrs`
 * (the crate compiled into the F7 WASI engine). Assertions are the crate's own tests
 * (src/training.rs, src/inference.rs, src/convertor_tests.rs); the sample collection is
 * the one those tests read (`tests/data/collection.anki21`, published at
 * https://github.com/open-spaced-repetition/fsrs-optimizer-burn/files/12394182/collection.anki21.zip,
 * sha256 of the zip ba1467bb0b1a6ce5580d059d54a4fcffe972824cf1100ad7b63d012af73dfed7).
 * The crate's `assert_approx_eq` tolerance is absolute 1e-4 (src/test_helpers.rs:16).
 */

type Host = Awaited<ReturnType<typeof createTestHost>>;
let host: Host;
beforeAll(async () => { host = await createTestHost({ plugins: [native] }); });
afterAll(async () => { await host.dispose(); });

const TOLERANCE = 1e-4;
const review = (rating: number, delta_t: number) => ({ rating, delta_t });
const item = (...pairs: [number, number][]): FsrsItem => ({ reviews: pairs.map(([r, t]) => review(r, t)) });

// ---------------------------------------------------------------- convertor_tests.rs port (test-only)

interface RevlogEntry { id: number; cid: number; button_chosen: number; last_interval: number; review_kind: number }
const LEARNING = 0;

/** `read_collection()`: the same SQL (?1/?2 written positionally) against the same SQLite file. */
function readCollection(): RevlogEntry[] {
  const zip = readZip(readFileSync(new URL('./fixtures/fsrs/collection.anki21.zip', import.meta.url)));
  const dir = mkdtempSync(join(tmpdir(), 'f7s-fsrs-'));
  try {
    const path = join(dir, 'collection.anki21');
    writeFileSync(path, zip.read('collection.anki21'));
    const db = new Database(path, { readonly: true });
    try {
      const now = Date.now();
      const rows = db.prepare(`SELECT *
        FROM revlog
        WHERE id < ?
        AND cid < ?
        AND cid IN (
            SELECT id
            FROM cards
            WHERE queue != 0
        )
        AND ease BETWEEN 1 AND 4
        AND (
            type != 3
            OR factor != 0
        )
        order by cid`).all(now, now) as Record<string, number>[];
      return rows.map(row => ({ id: row.id!, cid: row.cid!, button_chosen: row.ease!, last_interval: row.lastIvl!, review_kind: row.type! }));
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function removeRevlogBeforeLastFirstLearn(entries: RevlogEntry[]): RevlogEntry[] {
  let last = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.review_kind === LEARNING) last = index;
    else if (last !== 0) break;
  }
  return entries[last]!.review_kind === LEARNING ? entries.slice(last) : [];
}

/** `convert_to_date(ts, 4, Asia/Shanghai)`: Shanghai has been fixed UTC+8 since 1991. */
const dayNumber = (timestamp: number): number => Math.floor((timestamp - 4 * 3_600_000 + 8 * 3_600_000) / 86_400_000);

function convertToFsrsItems(input: RevlogEntry[]): [number, FsrsItem][] {
  const entries = removeRevlogBeforeLastFirstLearn(input).map(entry => ({ ...entry }));
  for (let i = 1; i < entries.length; i += 1) {
    entries[i]!.last_interval = dayNumber(entries[i]!.id) - dayNumber(entries[i - 1]!.id);
  }
  const out: [number, FsrsItem][] = [];
  for (let idx = 1; idx < entries.length; idx += 1) {
    const reviews = entries.slice(0, idx + 1).map(r => review(r.button_chosen, Math.max(r.last_interval, 0)));
    if (reviews.at(-1)!.delta_t > 0) out.push([entries[idx]!.id, { reviews }]);
  }
  return out;
}

function ankiToFsrsWithCardIds(revlogs: RevlogEntry[]): [FsrsItem[], number[]] {
  const flat: [number, number, FsrsItem][] = [];
  for (let start = 0; start < revlogs.length;) {
    let end = start;
    while (end < revlogs.length && revlogs[end]!.cid === revlogs[start]!.cid) end += 1;
    for (const [id, converted] of convertToFsrsItems(revlogs.slice(start, end))) flat.push([id, revlogs[start]!.cid, converted]);
    start = end;
  }
  flat.sort((a, b) => a[0] - b[0]); // stable, like sort_by_cached_key
  return [flat.map(entry => entry[2]), flat.map(entry => entry[1])];
}

const longTermReviewCount = (fsrsItem: FsrsItem): number => fsrsItem.reviews.filter(r => r.delta_t > 0).length;

/** dataset.rs `filter_outlier` (public crate fn used by inference.rs::test_evaluate). */
function filterOutlier(initialization: FsrsItem[], trainset: FsrsItem[]): [FsrsItem[], FsrsItem[]] {
  const groups = new Map<number, Map<number, FsrsItem[]>>();
  for (const entry of initialization) {
    const rating = entry.reviews[0]!.rating;
    const deltaT = entry.reviews.at(-1)!.delta_t;
    if (!groups.has(rating)) groups.set(rating, new Map());
    const byDelta = groups.get(rating)!;
    if (!byDelta.has(deltaT)) byDelta.set(deltaT, []);
    byDelta.get(deltaT)!.push(entry);
  }
  const filtered: FsrsItem[] = [];
  const removed = Array.from({ length: 5 }, () => new Set<number>());
  for (const rating of [...groups.keys()].sort((a, b) => a - b)) {
    const sub = [...groups.get(rating)!.entries()].sort((a, b) => (b[1].length - a[1].length) || (b[0] - a[0]));
    const total = sub.reduce((sum, [, group]) => sum + group.length, 0);
    let hasBeenRemoved = 0;
    for (const [deltaT, group] of [...sub].reverse()) {
      if (hasBeenRemoved + group.length >= Math.max(20, Math.floor(total / 20))) {
        if (group.length >= 6 && deltaT <= (rating !== 4 ? 100 : 365)) filtered.push(...group);
        else removed[rating]!.add(deltaT);
      } else {
        hasBeenRemoved += group.length;
        removed[rating]!.add(deltaT);
      }
    }
  }
  const kept = trainset.filter(entry => !removed[entry.reviews[0]!.rating]!.has(entry.reviews.find(r => r.delta_t > 0)!.delta_t));
  return [filtered, kept];
}

const revlogs = readCollection();
const [ankiItems, ankiCardIds] = ankiToFsrsWithCardIds(revlogs);

// ---------------------------------------------------------------- crate fixtures

// inference.rs::tests::PARAMETERS
const PARAMETERS = [
  0.6845422, 1.6790825, 4.7349424, 10.042885, 7.4410233, 0.64219797, 1.071918,
  0.0025195254, 1.432437, 0.1544, 0.8692766, 2.0696752, 0.0953, 0.2975,
  2.4691248, 0.19542035, 3.201072, 0.18046261, 0.121442534,
];

/** training.rs `synthetic_card_id_training_data`. */
function syntheticCardIdTrainingData(): [FsrsItem[], number[]] {
  const items: FsrsItem[] = [];
  const cardIds: number[] = [];
  for (let cardIdx = 0; cardIdx < 32; cardIdx += 1) {
    const reviews = [
      review(3, 0),
      review(3, 2),
      review(cardIdx % 6 === 0 ? 1 : cardIdx % 4 === 0 ? 4 : 3, 3 + cardIdx % 7),
      review(cardIdx % 5 === 0 ? 2 : cardIdx % 3 === 0 ? 1 : 4, 1 + (cardIdx * 3) % 11),
      review(cardIdx % 7 === 0 ? 1 : 3, 2 + (cardIdx * 5) % 17),
    ];
    for (let len = 2; len <= reviews.length; len += 1) {
      items.push({ reviews: reviews.slice(0, len) });
      cardIds.push(10_000 + cardIdx);
    }
  }
  return [items, cardIds];
}

/** training.rs `disabled_short_term_regression_items`. */
function disabledShortTermRegressionItems(): FsrsItem[] {
  const initialization = Array.from({ length: 30 }, (_, idx) => item([3, 0], [idx % 7 === 0 ? 1 : 3, 2]));
  const training = Array.from({ length: 100 }, (_, idx) => item([3, 0], [idx % 5 === 0 ? 1 : 3, 2], [idx % 6 === 0 ? 1 : 4, idx * 3 % 14 + 1]));
  return [...initialization, ...training];
}

async function fsrsError(promise: Promise<unknown>): Promise<FsrsError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(FsrsError);
  return error as FsrsError;
}

const close = (actual: readonly number[], expected: readonly number[]): void => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(Math.abs(value - expected[index]!), `index ${index}: ${value} vs ${expected[index]}`).toBeLessThanOrEqual(TOLERANCE));
};

describe('fsrs 6.6.2 sample collection (convertor_tests.rs, test-only port)', () => {
  it('test_conversion_works / test_ordering_of_inputs_should_not_change', () => {
    expect(revlogs).toHaveLength(24394);
    expect(ankiItems).toHaveLength(14290);
    expect(ankiItems.reduce((sum, entry) => sum + longTermReviewCount(entry) + 1, 0)).toBe(49382 + 14290);
    expect(ankiItems[0]).toEqual(item([4, 0], [3, 3]));
    const single = convertToFsrsItems(revlogs.filter(r => r.cid === 1528947214762)).map(([, converted]) => converted);
    expect(single).toEqual([
      item([3, 0], [4, 0], [3, 5]),
      item([3, 0], [4, 0], [3, 5], [3, 10]),
      item([3, 0], [4, 0], [3, 5], [3, 10], [3, 22]),
      item([3, 0], [4, 0], [3, 5], [3, 10], [3, 22], [2, 56]),
      item([3, 0], [4, 0], [3, 5], [3, 10], [3, 22], [2, 56], [3, 64]),
    ]);
  });
});

describe('nativeFsrs.evaluate (FSRS::evaluate, fsrs 6.6.2 via WASI)', () => {
  it('inference.rs test_evaluate', async () => {
    const initialization = ankiItems.filter(entry => longTermReviewCount(entry) === 1);
    const train = ankiItems.filter(entry => longTermReviewCount(entry) !== 1);
    const [filteredInit, filteredTrain] = filterOutlier(initialization, train);
    const items = [...filteredInit, ...filteredTrain];
    const evaluate = async (parameters: readonly number[]): Promise<number[]> => {
      const metrics = await host.ctx.nativeFsrs.evaluate(parameters, items);
      return [metrics.logLoss, metrics.rmseBins];
    };
    close(await evaluate([
      0.335561, 1.6840581, 5.166598, 11.659035, 7.466705, 0.7205129, 2.622295, 0.001,
      1.315015, 0.10468433, 0.8349206, 1.822305, 0.12473127, 0.26111007, 2.3030033,
      0.13117497, 3.0265594, 0.41468078, 0.09714265, 0.106824234, 0.20447432,
    ]), [0.20580745, 0.026005825]);
    close(await evaluate(DEFAULT_PARAMETERS), [0.20967911, 0.030774858]);
    close(await evaluate(PARAMETERS), [0.2086574, 0.030946612]);
  }, 120_000);

  it('reports FSRSError variants (empty items, invalid parameter count)', async () => {
    expect((await fsrsError(host.ctx.nativeFsrs.evaluate(DEFAULT_PARAMETERS, []))).message).toBe('NotEnoughData');
    expect((await fsrsError(host.ctx.nativeFsrs.evaluate([1, 2, 3], [item([3, 0], [3, 1])]))).kind).toBe('InvalidParameters');
  });
});

describe('nativeFsrs.optimize (fsrs::compute_parameters, fsrs 6.6.2 via WASI)', () => {
  it('training.rs test_compute_parameters_with_card_ids_matches_without_card_ids', async () => {
    const [items, cardIds] = syntheticCardIdTrainingData();
    const withCardIds = await host.ctx.nativeFsrs.optimize({ trainSet: items, cardIds, enableShortTerm: true, numRelearningSteps: null });
    const withoutCardIds = await host.ctx.nativeFsrs.optimize({ trainSet: items, cardIds: null, enableShortTerm: true, numRelearningSteps: null });
    expect(withCardIds).toHaveLength(21);
    expect(withoutCardIds).toHaveLength(21);
    expect(withCardIds.every(Number.isFinite)).toBe(true);
    expect(withoutCardIds.every(Number.isFinite)).toBe(true);
    const maxDiff = Math.max(...withCardIds.map((value, i) => Math.abs(value - withoutCardIds[i]!)));
    expect(maxDiff).toBeLessThanOrEqual(1e-3);
    const withMetrics = await host.ctx.nativeFsrs.evaluate(withCardIds, items);
    const withoutMetrics = await host.ctx.nativeFsrs.evaluate(withoutCardIds, items);
    expect(Math.abs(withMetrics.logLoss - withoutMetrics.logLoss)).toBeLessThanOrEqual(1e-4);
    expect(Math.abs(withMetrics.rmseBins - withoutMetrics.rmseBins)).toBeLessThanOrEqual(1e-4);
  }, 120_000);

  it('training.rs test_disabled_short_term_compute_parameters_zeroes_short_term_parameters', async () => {
    const parameters = await host.ctx.nativeFsrs.optimize({ trainSet: disabledShortTermRegressionItems(), enableShortTerm: false });
    expect(parameters.slice(17, 20)).toEqual([0, 0, 0]);
  }, 120_000);

  it('training.rs test_compute_parameters_rejects_mismatched_card_ids / rejects_invalid_items', async () => {
    const mismatched = await fsrsError(host.ctx.nativeFsrs.optimize({ trainSet: [item([4, 0], [3, 2])], cardIds: [] }));
    expect(mismatched.kind).toBe('InvalidInput');
    expect(mismatched.message).toBe('InvalidInput');
    for (const invalid of [{ reviews: [] }, item([5, 0])]) {
      expect((await fsrsError(host.ctx.nativeFsrs.optimize({ trainSet: [invalid] }))).kind).toBe('InvalidInput');
    }
  });

  it('rejects card ids that are not i64 before reaching the engine', async () => {
    await expect(host.ctx.nativeFsrs.optimize({ trainSet: [item([4, 0], [3, 2])], cardIds: [1.5] })).rejects.toBeInstanceOf(TypeError);
    await expect(host.ctx.nativeFsrs.optimize({ trainSet: [item([4, 0], [3, 2])], cardIds: [2n ** 63n] })).rejects.toBeInstanceOf(TypeError);
  });

  it('fsrs_review_service.rs optimize_parameters call shape on the sample collection (card_ids, short-term on)', async () => {
    const optimized = await host.ctx.nativeFsrs.optimize({
      trainSet: ankiItems, cardIds: ankiCardIds, enableShortTerm: true, numRelearningSteps: 1,
    });
    expect(optimized).toHaveLength(21);
    expect(optimized.every(Number.isFinite)).toBe(true);
    const current = await host.ctx.nativeFsrs.evaluate(DEFAULT_PARAMETERS, ankiItems);
    const trained = await host.ctx.nativeFsrs.evaluate(optimized, ankiItems);
    // The Rust caller applies parameters only when `optimized.log_loss + 1e-6 < current.log_loss`.
    expect(trained.logLoss + 1e-6).toBeLessThan(current.logLoss);
  }, 600_000);

  it('terminates the engine when the signal aborts', async () => {
    const controller = new AbortController();
    // Training makes a single WASI call, environ_sizes_get, part-way through the run; holding the
    // guest there keeps the optimizer running until the abort lands, however fast the machine is.
    let held = 0;
    holdNextWasmRun({ call: 'environ_sizes_get', nth: 1, onHeld: () => { held += 1; controller.abort(); } });
    const pending = host.ctx.nativeFsrs.optimize({ trainSet: ankiItems, cardIds: ankiCardIds }, { signal: controller.signal });
    await expect(pending).rejects.toBeInstanceOf(WasmCancelledError);
    expect(held).toBe(1);
  }, 60_000);
});

describe('nativeFsrs.nextStates/memoryState f32 port against the fsrs 6.6.2 crate', () => {
  async function crateNextStates(parameters: readonly number[], memory: { stability: number; difficulty: number } | null,
    desiredRetention: number, daysElapsed: number): Promise<FsrsNextStates> {
    const run = await runWasm({ engine: 'fsrs', op: 'next_states', parameters, memory, desired_retention: desiredRetention, days_elapsed: daysElapsed });
    try { return (run.response as { value: FsrsNextStates }).value; } finally { await removeRun(run); }
  }
  async function crateMemoryState(parameters: readonly number[], fsrsItem: FsrsItem): Promise<{ stability: number; difficulty: number }> {
    const run = await runWasm({ engine: 'fsrs', op: 'memory_state', parameters, item: fsrsItem, starting_state: null });
    try { return (run.response as { value: { stability: number; difficulty: number } }).value; } finally { await removeRun(run); }
  }
  const f32 = (states: FsrsNextStates) => Object.fromEntries((['again', 'hard', 'good', 'easy'] as const).map(key => [key, {
    memory: { stability: Math.fround(states[key].memory.stability), difficulty: Math.fround(states[key].memory.difficulty) },
    interval: Math.fround(states[key].interval),
  }]));

  it('inference.rs test_next_states: crate and port agree bit-for-bit with the crate expectations', async () => {
    const history = item([1, 0], [3, 1], [3, 3], [3, 8]);
    const crateState = await crateMemoryState(PARAMETERS, history);
    const portState = host.ctx.nativeFsrs.memoryState(PARAMETERS, history, null);
    expect(Math.fround(portState.stability)).toBe(Math.fround(crateState.stability));
    expect(Math.fround(portState.difficulty)).toBe(Math.fround(crateState.difficulty));
    const expected = {
      again: { memory: { stability: Math.fround(2.9691455), difficulty: Math.fround(8.000659) }, interval: Math.fround(2.9691455) },
      hard: { memory: { stability: Math.fround(17.091452), difficulty: Math.fround(7.6913934) }, interval: Math.fround(17.091452) },
      good: { memory: { stability: Math.fround(31.722992), difficulty: Math.fround(7.382128) }, interval: Math.fround(31.722992) },
      easy: { memory: { stability: Math.fround(71.7502), difficulty: Math.fround(7.0728626) }, interval: Math.fround(71.7502) },
    };
    expect(f32(await crateNextStates(PARAMETERS, crateState, 0.9, 21))).toEqual(expected);
    expect(f32(host.ctx.nativeFsrs.nextStates(PARAMETERS, portState, 0.9, 21))).toEqual(expected);
  });

  // Known deviation (architect ruling, SPEC "nextStates/memoryState 已知偏差"): the port rounds JS
  // Math.exp/pow once from f64, the crate calls the platform libm expf/powf, which already differs
  // between Rust desktop builds on macOS/Windows/Linux. Sweep job 20261104195914-33f9d7 measured at most
  // 13 ulp; the accepted bound is 16 ulp. X7 differential runs confirm per platform.
  const ULP_BOUND = 16;
  const ulps = (a: number, b: number): number => {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat32(0, a);
    view.setFloat32(4, b);
    return Math.abs(view.getInt32(0) - view.getInt32(4));
  };
  it('stays within 16 ulp of the crate across the sample collection histories (default parameters)', async () => {
    const sample = ankiItems.filter((_, index) => index % 40 === 0);
    let worst = 0;
    for (const history of sample) {
      const crate = await crateMemoryState(DEFAULT_PARAMETERS, history);
      const port = host.ctx.nativeFsrs.memoryState(DEFAULT_PARAMETERS, history, null);
      worst = Math.max(worst, ulps(port.stability, crate.stability), ulps(port.difficulty, crate.difficulty));
      const crateNext = await crateNextStates(DEFAULT_PARAMETERS, crate, 0.9, 7);
      const portNext = host.ctx.nativeFsrs.nextStates(DEFAULT_PARAMETERS, crate, 0.9, 7);
      for (const key of ['again', 'hard', 'good', 'easy'] as const) {
        worst = Math.max(worst, ulps(portNext[key].memory.stability, crateNext[key].memory.stability),
          ulps(portNext[key].memory.difficulty, crateNext[key].memory.difficulty),
          ulps(portNext[key].interval, crateNext[key].interval));
      }
      expect(worst, JSON.stringify(history)).toBeLessThanOrEqual(ULP_BOUND);
    }
  }, 300_000);
});
