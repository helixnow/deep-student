/** Explain a completed isolated Node Host trial using its read-only rating logs. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildFsrs, logicalDayKey } from '../../host/plugins/review/src/fsrs-scheduler.ts';
import { scheduleAllRatings } from '../../host/plugins/review/src/review-scheduling.ts';
import { defaultSchedulerConfig } from '../../host/plugins/review/src/fsrs-types.ts';
import { loadV7 } from './trial-model.mjs';

const [reportPath, dependencyEntry] = process.argv.slice(2);
if (!reportPath || !dependencyEntry) throw new Error('Usage: node scripts/fsrs-eval/diagnose.mjs <trial report.json> <ts-fsrs package.json>');
const root = dirname(realpathSync(reportPath));
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
assert.ok(basename(root).startsWith('dstu-fsrs-trial-'));
assert.equal(realpathSync(report.root), root);
assert.equal(report.timezone, 'Asia/Shanghai');
process.env.TZ = report.timezone;
const horizon = report.completeHistory.days;
const cutoff = report.results.v6.workload.daily[horizon - 1].date;
const grades = ['again', 'hard', 'good', 'easy'];
const phaseNames = ['新卡', '学习', '正式复习', '重学'];
const gradeNames = ['重来', '困难', '良好', '简单'];
const timingNames = { first: '首次', same: '同日', cross: '跨日' };
const config = { ...defaultSchedulerConfig(), enableFuzz: false };
const dayMs = 86_400_000;
const minuteMs = 60_000;
const dayKey = ms => logicalDayKey(ms, config.dayRolloverHour, 8 * 60);
const displayTime = ms => new Date(ms + 8 * 60 * minuteMs).toISOString().slice(0, 19).replace('T', ' ');
const count = (map, key, n = 1) => map[key] = (map[key] ?? 0) + n;
const median = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length / 2) - 1];
const direction = (v6, v7) => v7 < v6 ? 'shorter' : v7 > v6 ? 'longer' : 'same';
const dirSummary = () => ({ shorter: 0, same: 0, longer: 0 });
const model6 = buildFsrs();
const model7 = loadV7(dependencyEntry);

function readLane(key) {
  const lane = report.results[key];
  const dir = realpathSync(lane.directory);
  assert.equal(dirname(dir), root);
  assert.ok(basename(dir).startsWith(`${key}-`));
  const path = join(dir, 'slots', 'slotA', 'mistakes.db');
  assert.equal(realpathSync(path), path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT anki_card_id AS card, rating, state_before AS before, state_after AS after,
      review_ms AS at, due_before_ms AS dueBefore, due_after_ms AS dueAfter, scheduled_days AS days,
      stability_after AS stability, difficulty_after AS difficulty, state_before_json AS snapshot, fsrs_params_version AS model
      FROM fsrs_review_logs WHERE deleted_at IS NULL ORDER BY anki_card_id, review_ms`).all();
    const byCard = new Map();
    for (const row of rows) {
      assert.equal(row.model, lane.version);
      const sequence = byCard.get(row.card) ?? [];
      const previous = sequence.at(-1);
      assert.ok(previous ? previous.at < row.at : row.before === 0);
      const day = dayKey(row.at);
      const snapshot = JSON.parse(row.snapshot);
      assert.equal(snapshot.reps, sequence.length);
      sequence.push({ ...row, snapshot, day, step: sequence.length + 1,
        timing: previous === undefined ? 'first' : day === previous.day ? 'same' : 'cross',
        delay: row.dueAfter - row.at, complete: day <= cutoff });
      byCard.set(row.card, sequence);
    }
    const perDay = new Map();
    for (const sequence of byCard.values()) for (const e of sequence) {
      const counts = perDay.get(e.day) ?? {};
      count(counts, ['new', 'learning', 'review', 'relearning'][e.before]);
      perDay.set(e.day, counts);
    }
    assert.equal(byCard.size, report.inputCards);
    for (const day of lane.workload.daily) for (const phase of ['new', 'learning', 'review', 'relearning']) {
      assert.equal(perDay.get(day.date)?.[phase] ?? 0, day[phase]);
    }
    return byCard;
  } finally {
    db.close();
  }
}

// Re-evaluate the other model on this lane's exact grades, phases and clock.
// Verify the native model reproduces its own stored due time for every row.
function fixedClock(sequence, nativeModel, out) {
  let memory6 = null;
  let memory7 = null;
  let last = null;
  for (const e of sequence) {
    if (!e.complete) break;
    const elapsed = last === null ? 0 : (e.at - last.at) / dayMs;
    const grade = grades[e.rating - 1];
    const b = e.snapshot;
    let raw6, raw7;
    const v6 = scheduleAllRatings({ ...b, stability: memory6?.stability ?? null, difficulty: memory6?.difficulty ?? null }, e.at, config, {
      nextStates(memory, target, logicalDays) {
        const all = model6.nextStates(memory, target, logicalDays);
        raw6 = all[grade];
        return all;
      },
    })[e.rating - 1];
    const v7 = scheduleAllRatings({ ...b, stability: memory7?.stability ?? null, difficulty: memory7?.difficulty ?? null }, e.at, config, {
      nextStates(_memory, target) {
        const all = Object.fromEntries(grades.map((g, i) => {
          const memory = model7.next_state(memory7, elapsed, i + 1);
          return [g, { memory, interval: model7.next_interval(memory, target) }];
        }));
        raw7 = all[grade];
        return all;
      },
    })[e.rating - 1];
    assert.equal(v6.state, e.after);
    assert.equal(v7.state, e.after);
    const actual = nativeModel === 'v6' ? v6 : v7;
    assert.equal(actual.dueMs, e.dueAfter);
    assert.equal(actual.stability, e.stability);
    assert.equal(actual.difficulty, e.difficulty);
    if (e.before === 2 && e.after === 2 && e.timing === 'cross') count(out[grade], direction(v6.dueMs, v7.dueMs));
    e.fixed = { v6Days: v6.scheduledDays, v7Days: v7.scheduledDays, model6Interval: raw6.interval, model7Interval: raw7.interval,
      stability6: raw6.memory.stability, slow7: raw7.memory.stability, fast7: raw7.memory.stabilityFast,
      difficulty6: raw6.memory.difficulty, difficulty7: raw7.memory.difficulty };
    memory6 = raw6.memory;
    memory7 = raw7.memory;
    last = e;
  }
}

const lanes = { v6: readLane('v6'), v7: readLane('v7') };
const byEvent = new Map();
const paired = new Map();
const workloadSummary = () => ({ fewer: 0, same: 0, more: 0 });
const byCard = workloadSummary();
const firstReview = Object.fromEntries(['shorter', 'same', 'longer'].map(d => [d, workloadSummary()]));
const fixed = {};
for (const [key, cards] of Object.entries(lanes)) {
  fixed[key] = Object.fromEntries(grades.slice(1).map(g => [g, dirSummary()]));
  for (const events of cards.values()) {
    for (const e of events) {
      if (!e.complete) break;
      const id = `${e.before}/${e.timing}/${e.rating}`;
      const row = byEvent.get(id) ?? { before: e.before, timing: e.timing, rating: e.rating, v6: [], v7: [], v6Count: 0, v7Count: 0 };
      row[`${key}Count`]++;
      if (e.after === 2) row[key].push(e.days);
      byEvent.set(id, row);
    }
    fixedClock(events, key, fixed[key]);
  }
}
for (const [card, events6] of lanes.v6) {
  const events7 = lanes.v7.get(card);
  const a = events6.filter(e => e.complete);
  const b = events7.filter(e => e.complete);
  const workload = b.length < a.length ? 'fewer' : b.length > a.length ? 'more' : 'same';
  count(byCard, workload);
  count(firstReview[direction(a.find(e => e.after === 2).days, b.find(e => e.after === 2).days)], workload);
  for (const [i, x] of a.slice(0, b.length).entries()) {
    const y = b[i];
    assert.deepEqual([x.rating, x.before, x.after, x.timing], [y.rating, y.before, y.after, y.timing]);
    const id = `${x.before}/${x.timing}/${x.rating}`;
    const row = paired.get(id) ?? { before: x.before, timing: x.timing, rating: x.rating, all: dirSummary(), toReview: dirSummary() };
    const change = direction(x.delay, y.delay);
    count(row.all, change);
    if (x.after === 2) count(row.toReview, change);
    paired.set(id, row);
  }
}

const rows = [...byEvent.values()].sort((a, b) => a.before - b.before || a.rating - b.rating).map(row => ({
  before: row.before, timing: row.timing, rating: row.rating, v6Count: row.v6Count, v7Count: row.v7Count,
  v6MedianToReviewDays: median(row.v6) ?? null, v7MedianToReviewDays: median(row.v7) ?? null,
  v6AtMinimum: row.before === 2 && row.rating > 1 ? row.v6.filter(d => d === row.rating - 1).length : null,
  v7AtMinimum: row.before === 2 && row.rating > 1 ? row.v7.filter(d => d === row.rating - 1).length : null,
  paired: paired.get(`${row.before}/${row.timing}/${row.rating}`),
}));
const samples = [
  ['1545198054720', '两次良好开局：首次排更远，后来评分更多'],
  ['1545023826133', '同样两次良好开局：继续答对，前 45 天评分更少'],
  ['1536221882215', '首次正式排期相同：后续困难与良好更快回到队列'],
  ['1545109501536', '首次就评简单：V7 首次正式排期超过 45 天窗口'],
].map(([card, label]) => ({ card, label, v6: lanes.v6.get(card), v7: lanes.v7.get(card) }));
const output = mkdtempSync(join(tmpdir(), 'dstu-fsrs-diagnosis-'));
const samplePoints = samples.map(({ card, label, v6 }) => ({ card, label, v6Clock: v6.filter(e => e.complete)
  .map(e => ({ step: e.step, rating: e.rating, before: e.before, at: displayTime(e.at), ...e.fixed })) }));
writeFileSync(join(output, 'breakdown.json'), JSON.stringify({
  source: reportPath, horizon, cutoff, rows, byCard, firstReview, fixed, samplePoints,
}, null, 2) + '\n');
const interval = e => e.days ? `${e.days} 天` : `${e.delay / minuteMs} 分钟`;
const cell = e => e ? `${displayTime(e.at)} → ${displayTime(e.dueAfter)}（${interval(e)}）${e.complete ? '' : ' †'}` : '—';
const lines = ['# V6 / V7 逐卡完整排期', '', '本机 Node Host 独立库。时间为上海时间；「→」后是写入的到期时间，并非下一次实际评分时间。† 表示该笔评分在前 45 天完整比较窗口之后；— 表示 90 天模拟内该版未走到这笔评分。卡片只有公开样本 ID，没有题面。', ''];
for (const { card, label, v6, v7 } of samples) {
  lines.push(`## ${card}：${label}`, '',
    `前 ${horizon} 天评分数：V6 ${v6.filter(e => e.complete).length}，V7 ${v7.filter(e => e.complete).length}；90 天：V6 ${v6.length}，V7 ${v7.length}。`, '',
    '| 第几次 | 评分 | 阶段变化 | V6 评分 → 到期 | V7 评分 → 到期 |', '| ---: | --- | --- | --- | --- |');
  for (let i = 0; i < Math.max(v6.length, v7.length); i++) {
    const e = v6[i] ?? v7[i];
    lines.push(`| ${i + 1} | ${gradeNames[e.rating - 1]} | ${phaseNames[e.before]} → ${phaseNames[e.after]} | ${cell(v6[i])} | ${cell(v7[i])} |`);
  }
  lines.push('');
}
writeFileSync(join(output, 'card-schedules.md'), lines.join('\n') + '\n');
console.log(JSON.stringify({ output, horizon, cutoff, rows: rows.map(r => [phaseNames[r.before], timingNames[r.timing], gradeNames[r.rating - 1],
  r.v6Count, r.v7Count, r.v7Count - r.v6Count, r.v6MedianToReviewDays, r.v7MedianToReviewDays, r.v6AtMinimum, r.v7AtMinimum,
  r.paired?.toReview]), byCard, firstReview, fixed }, null, 2));
