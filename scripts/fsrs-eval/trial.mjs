/** Launch an isolated review Host pair using Electron's bundled Node. */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../host/kernel/testing.ts';
import { createStorageService } from '../../host/platform/storage/service.ts';
import review, { createReviewTrialPlugin } from '../../host/plugins/review/index.ts';
import { FSRS_PARAMS_VERSION } from '../../host/plugins/review/src/fsrs-types.ts';
import { FSRS7_VERSION } from '../../host/plugins/review/src/fsrs7.ts';

const [csvPath] = process.argv.slice(2);
if (!csvPath) {
  throw new Error('Usage: Electron (ELECTRON_RUN_AS_NODE=1) scripts/fsrs-eval/trial.mjs <revlog.csv>');
}
process.env.TZ = 'Asia/Shanghai';
const DAY = 86_400_000;
const trialDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });
const MINUTE = 60_000;
const CARD_COUNT = 300;
const DAYS = 90;
const START = Date.parse('2026-01-05T08:00:00+08:00');
const NEW_LIMIT = 20;
const REVIEW_LIMIT = 200;
const wallClock = Date.now;
let trialMs = START;
const root = mkdtempSync(join(tmpdir(), 'dstu-fsrs-trial-'));

function readSample() {
  const [header, ...rows] = readFileSync(csvPath, 'utf8').trimEnd().split(/\r?\n/);
  assert.equal(header.replace(/^\uFEFF/, ''), 'review_time,card_id,review_rating,review_duration,review_state');
  const byCard = new Map();
  for (const row of rows) {
    const [time, id, rating, , state] = row.split(',');
    if (state === '4') continue;
    assert.match(id, /^\d+$/);
    assert.match(rating, /^[1-4]$/);
    assert.match(state, /^[0-3]$/);
    assert.ok(Number.isSafeInteger(+time) && +time > 0);
    const events = byCard.get(id) ?? [];
    events.push({ time: +time, rating: +rating, state: +state });
    byCard.set(id, events);
  }
  const candidates = [...byCard.entries()].flatMap(([id, rows]) => {
    rows.sort((a, b) => a.time - b.time);
    const start = rows.findLastIndex(event => event.state === 0);
    return start !== -1 && rows.length - start >= 40
      ? [{ id, grades: rows.slice(start).map(event => event.rating) }]
      : [];
  }).sort((a, b) => a.id.localeCompare(b.id));
  assert.ok(candidates.length >= CARD_COUNT, 'Not enough cards with at least 40 grades in the public CSV');
  return Array.from({ length: CARD_COUNT }, (_, i) => candidates[Math.floor(i * candidates.length / CARD_COUNT)]);
}

async function openLane(prefix, useV7) {
  const dir = mkdtempSync(join(root, prefix + '-'));
  const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  try {
    const db = storage.database('mistakes');
    const migrationRoot = 'resources/app/migrations';
    for (const f of readdirSync(join(migrationRoot, 'mistakes')).filter(f => f.endsWith('.sql')).sort()) {
      db.exec(readFileSync(join(migrationRoot, 'mistakes', f), 'utf8'));
    }
    const vfs = storage.database('vfs');
    for (const f of ['V20260718__add_mastery_tables.sql', 'V20260719__mastery_events_signal.sql',
      'V20260720__mastery_events_sync.sql', 'V20260909__mastery_events_insight_source.sql']) {
      vfs.exec(readFileSync(join(migrationRoot, 'vfs', f), 'utf8'));
    }
    const host = await createTestHost({ app: { dataDir: dir },
      plugins: [useV7 ? createReviewTrialPlugin() : review], provide: { storage } });
    await host.invoke('fsrs_update_scheduler_config', { update: {
      desiredRetention: 0.9, newPerDay: NEW_LIMIT, reviewsPerDay: REVIEW_LIMIT,
      enableFuzz: false, reviewOrder: 'due', leechAction: 'mark',
    } });
    db.run(`INSERT INTO document_tasks
      (id,document_id,original_document_name,segment_index,content_segment,status,anki_generation_options_json)
      VALUES ('trial','trial','default',0,'trial','Completed','{}')`);
    return { dir, storage, db, host };
  } catch (error) {
    storage.dispose();
    throw error;
  }
}

async function enqueue(lane, cards) {
  lane.db.transaction(db => {
    for (const { id } of cards) db.run(`INSERT INTO anki_cards(id,task_id,front,back,source_type,source_id)
      VALUES (?1,'trial',?1,'trial answer','document','trial')`, [id]);
  });
  const result = await lane.host.invoke('fsrs_enqueue_cards', { ankiCardIds: cards.map(card => card.id) });
  assert.equal(result.enqueued, cards.length);
  return result.states;
}

function comparable(state) {
  return Object.fromEntries(['id', 'ankiCardId', 'state', 'stability', 'difficulty', 'elapsedDays',
    'scheduledDays', 'learningStep', 'dueMs', 'lastReviewMs', 'reps', 'lapses', 'fsrsParamsVersion']
    .map(key => [key, state[key]]));
}

async function exercise(lane, version) {
  const invoke = (cmd, args) => lane.host.invoke(cmd, args);
  const [initial] = await enqueue(lane, [{ id: 'smoke' }]);
  const preview = () => invoke('fsrs_preview_intervals', { cardStateId: initial.id });
  const rate = (rating, clientOpId = crypto.randomUUID()) => invoke('fsrs_rate', {
    cardStateId: initial.id, rating, durationMs: 1_000, clientOpId,
  });
  const undo = (answer) => invoke('fsrs_undo_last_review', { cardStateId: initial.id, expectedLogId: answer.logId });
  const assertPreview = (options, rating, answer) => {
    assert.equal(options.intervals.length, 4);
    assert.equal(options.intervals.find(item => item.rating === rating).dueMs, answer.dueMs);
    assert.equal(answer.cardState.fsrsParamsVersion, version);
  };

  const firstPreview = await preview();
  const first = await rate(3);
  assertPreview(firstPreview, 3, first);
  assert.equal(first.dueMs - trialMs, 10 * MINUTE);
  assert.equal(first.cardState.state, 1);

  trialMs = first.dueMs;
  const secondPreview = await preview();
  const second = await rate(3);
  assertPreview(secondPreview, 3, second);
  assert.equal(second.cardState.state, 2);
  assert.equal(second.cardState.elapsedDays, version === FSRS7_VERSION ? 10 / 1440 : 0);
  const restoredSecond = await undo(second);
  assert.deepEqual(comparable(restoredSecond.state), comparable(first.cardState));
  assert.deepEqual(await preview(), secondPreview);
  assert.ok(lane.db.pluck('SELECT deleted_at FROM fsrs_review_logs WHERE id = ?1', [second.logId]));
  const rerated = await rate(3);
  assert.deepEqual(comparable(rerated.cardState), comparable(second.cardState));

  trialMs = rerated.dueMs;
  const lapsePreview = await preview();
  // Exercise the other three options on the same cross-day state as Again.
  for (const rating of [2, 3, 4]) {
    const answer = await rate(rating);
    assertPreview(lapsePreview, rating, answer);
    assert.deepEqual(comparable((await undo(answer)).state), comparable(rerated.cardState));
    assert.deepEqual(await preview(), lapsePreview);
  }
  const lapse = await rate(1);
  assertPreview(lapsePreview, 1, lapse);
  assert.equal(lapse.cardState.state, 3);
  assert.equal(lapse.dueMs - trialMs, 10 * MINUTE);
  assert.deepEqual(comparable((await undo(lapse)).state), comparable(rerated.cardState));
  assert.deepEqual(await preview(), lapsePreview);
  await undo(rerated);
  assert.deepEqual(comparable((await undo(first)).state), comparable(initial));
  assert.equal(lane.db.pluck('SELECT COUNT(*) FROM fsrs_review_logs WHERE deleted_at IS NULL'), 0);
  if (version === FSRS7_VERSION) {
    // Same timestamp, reverse ID order: undo and the chart must follow insertion order.
    const firstOp = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    const lastOp = '00000000-0000-4000-8000-000000000000';
    const earlier = await rate(3, firstOp);
    const latest = await rate(2, lastOp);
    assert.equal((await rate(2, lastOp)).logId, latest.logId);
    const memory = await invoke('fsrs_get_card_memory_history', { cardStateId: initial.id });
    assert.deepEqual(memory.reviews.map(review => review.rating), [3, 2]);
    assert.equal(memory.card.lastRating, 2);
    assert.deepEqual(comparable((await undo(latest)).state), comparable(earlier.cardState));
    assert.deepEqual(comparable((await undo(earlier)).state), comparable(initial));
  }
  const history = lane.db.all('SELECT fsrs_params_version AS version FROM fsrs_review_logs');
  assert.ok(history.every(log => log.version === version));
  return {
    firstPreviewMinutes: firstPreview.intervals.map(item => item.intervalMs / MINUTE),
    sameDayPreviewMinutes: secondPreview.intervals.map(item => item.intervalMs / MINUTE),
    graduatedIntervalDays: second.scheduledDays,
    reviewPreviewDays: lapsePreview.intervals.map(item => item.intervalMs / DAY),
    lapseDelayMinutes: (lapse.dueMs - trialMs) / MINUTE,
    exactUndoAndRerate: true,
  };
}

const sum = values => values.reduce((a, b) => a + b, 0);
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];

function summarize(daily) {
  const totals = Object.fromEntries(['new', 'review', 'learning', 'relearning', 'total', 'ratingsUnavailable']
    .map(key => [key, sum(daily.map(day => day[key]))]));
  const afterIntake = daily.slice(Math.ceil(CARD_COUNT / NEW_LIMIT));
  return {
    totals, averageDaily: totals.total / daily.length,
    averageDailyAfterIntake: afterIntake.length ? sum(afterIntake.map(day => day.total)) / afterIntake.length : null,
    p90Daily: quantile(daily.map(day => day.total), 0.9),
    peakDaily: Math.max(...daily.map(day => day.total)),
    maxReviewBacklog: Math.max(...daily.map(day => day.reviewBacklog)),
  };
}

async function simulate(lane, cards, version) {
  const invoke = (cmd, args) => lane.host.invoke(cmd, args);
  const byId = new Map(cards.map(card => [card.id, card]));
  const daily = [];
  const after = [];
  for (let day = 0; day < DAYS; day++) {
    const morning = START + day * DAY;
    const close = morning + 14 * 60 * MINUTE;
    trialMs = morning;
    const cohort = cards.slice(day * NEW_LIMIT, (day + 1) * NEW_LIMIT);
    if (cohort.length) await enqueue(lane, cohort);
    const date = trialDate.format(morning);
    const counts = { day: day + 1, date, new: 0, review: 0, learning: 0, relearning: 0, total: 0,
      reviewBacklog: 0, ratingsUnavailable: 0 };
    while (trialMs < close) {
      const queue = await invoke('fsrs_get_due', { limit: 50, readOnly: true });
      if (queue.length === 0) {
        const next = lane.db.pluck(`SELECT MIN(due_ms) FROM fsrs_card_states
          WHERE deleted_at IS NULL AND suspended = 0 AND state IN (1,3) AND due_ms > ?1`, [trialMs]);
        if (next == null || next >= close) break;
        trialMs = next;
        continue;
      }
      for (const card of queue) {
        if (trialMs >= close) break;
        const grades = byId.get(card.ankiCardId).grades;
        const rating = grades[card.reps];
        if (rating === undefined) {
          // No later grade was observed. Stop only this trial card on its first
          // unsupported opportunity rather than fabricating outcomes.
          await invoke('fsrs_suspend_card', { cardStateId: card.id });
          counts.ratingsUnavailable++;
          continue;
        }
        const answer = await invoke('fsrs_rate', {
          cardStateId: card.id, rating, durationMs: 3_000, clientOpId: crypto.randomUUID(),
        });
        assert.equal(answer.cardState.fsrsParamsVersion, version);
        counts[['new', 'learning', 'review', 'relearning'][card.state]]++;
        counts.total++;
        if (answer.cardState.state === 2) after.push(answer.scheduledDays);
        trialMs += 3_000;
      }
    }
    const stats = await invoke('fsrs_get_stats');
    assert.equal(stats.reviewsToday, counts.total);
    assert.ok(counts.new <= NEW_LIMIT && counts.review <= REVIEW_LIMIT);
    counts.reviewBacklog = stats.backlogReview;
    daily.push(counts);
  }
  const summary = summarize(daily);
  assert.equal(summary.totals.new, CARD_COUNT);
  return {
    ...summary,
    scheduledReviewDays: { p10: quantile(after, 0.1), median: quantile(after, 0.5), p90: quantile(after, 0.9) },
    daily,
  };
}

const cards = readSample();
const results = {};
const variants = [
  ['v6', FSRS_PARAMS_VERSION, false], ['v7', FSRS7_VERSION, true],
];
Date.now = () => trialMs;
try {
  for (const [key, version, scheduler] of variants) {
    trialMs = START;
    const smokeLane = await openLane(key + '-smoke', scheduler);
    try { results[key] = { version, smoke: await exercise(smokeLane, version) }; }
    finally { await smokeLane.host.dispose(); smokeLane.storage.dispose(); }
    console.error(`${key}: preview, rating and undo verified in ${smokeLane.dir}`);
  }
  for (const [key, version, scheduler] of variants) {
    trialMs = START;
    const lane = await openLane(key, scheduler);
    try {
      results[key].directory = lane.dir;
      results[key].workload = await simulate(lane, cards, version);
    } finally { await lane.host.dispose(); lane.storage.dispose(); }
    console.error(`${key}: ${DAYS} simulation days completed in ${lane.dir}`);
  }
} finally {
  Date.now = wallClock;
}
const firstUnsupportedDay = Math.min(...Object.values(results).map(lane =>
  lane.workload.daily.find(day => day.ratingsUnavailable > 0)?.day ?? (DAYS + 1)));
const completeDays = firstUnsupportedDay - 1;
assert.ok(completeDays > 0);
const completeHistory = { days: completeDays, results: Object.fromEntries(Object.entries(results).map(([key, lane]) =>
  [key, summarize(lane.workload.daily.slice(0, completeDays))])) };
const report = { root, inputCards: CARD_COUNT, days: DAYS, timezone: process.env.TZ, completeHistory, results };
writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const fields = Object.keys(results.v6.workload.daily[0]).slice(2);
const dailyRows = results.v6.workload.daily.map((day, i) => [day.day, day.date,
  ...fields.map(key => day[key]), ...fields.map(key => results.v7.workload.daily[i][key])].join(','));
writeFileSync(join(root, 'daily.csv'), [['day', 'date', ...['v6', 'v7'].flatMap(model => fields.map(key => `${model}_${key}`))].join(','),
  ...dailyRows].join('\n') + '\n');
console.log(JSON.stringify({ ...report, results: Object.fromEntries(Object.entries(results).map(([key, lane]) => {
  const { daily, ...summary } = lane.workload;
  return [key, { ...lane, workload: summary }];
})) }, null, 2));
