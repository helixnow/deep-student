/**
 * Offline default-weight replay. No application database or due dates are read or written.
 * Usage: node scripts/fsrs-eval/replay.mjs <revlog.csv> <path to ts-fsrs package.json>
 * Input: numeric-card-ID sample CSV linked by the official ts-fsrs playground.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { nextStates, powerForgettingCurve } from '../../host/platform/native/fsrs/model.ts';
import { logicalDaysBetween } from '../../host/plugins/review/src/fsrs-scheduler.ts';

const [csvPath, dependencyEntry] = process.argv.slice(2);
if (!csvPath || !dependencyEntry) {
  throw new Error('Usage: node scripts/fsrs-eval/replay.mjs <revlog.csv> <path to ts-fsrs package.json>');
}
const requireV7 = createRequire(resolve(dependencyEntry));
const { FSRS7Algorithm, FSRS7_DEFAULT_WEIGHTS, FSRS7_MODEL_BOUNDS } = requireV7('ts-fsrs/models/fsrs-7');
const v7 = new FSRS7Algorithm(FSRS7_DEFAULT_WEIGHTS, FSRS7_MODEL_BOUNDS);

const DAY = 86_400_000;
const OFFSET_MINUTES = 480; // Asia/Shanghai on the dates in the public CSV, no DST.
const ROLLOVER_HOUR = 4;
const TARGET = 0.9;
const losses = () => ({ n: 0, passed: 0, predicted: 0, logLoss: 0, brier: 0 });
const group = () => ({ v6: losses(), v6Continuous: losses(), v7: losses(), intervalV6: [], intervalV7: [], ratio: [] });
const groups = { sameDay: group(), crossDay: group() };
const histories = new Map();
let totalRows = 0;
let skippedFiltered = 0;
const [header, ...lines] = readFileSync(csvPath, 'utf8').trimEnd().split(/\r?\n/);
if (header.replace(/^\uFEFF/, '') !== 'review_time,card_id,review_rating,review_duration,review_state') {
  throw new Error('Unexpected CSV header');
}
for (const [index, line] of lines.entries()) {
  const [rawTime, cardId, rawRating, , rawState] = line.split(',');
  const ms = Number(rawTime);
  const rating = Number(rawRating);
  const phase = Number(rawState);
  totalRows++;
  if (!/^\d+$/.test(cardId) || !Number.isSafeInteger(ms) || ms <= 0 ||
      !Number.isInteger(rating) || rating < 1 || rating > 4 ||
      !Number.isInteger(phase) || phase < 0 || phase > 4) {
    throw new Error(`Invalid row ${index + 2}`);
  }
  if (phase === 4) {
    skippedFiltered++; // Filtered/cram reviews are outside the documented 0–3 review states.
    continue;
  }
  const history = histories.get(cardId) ?? [];
  history.push({ ms, rating, phase });
  histories.set(cardId, history);
}

function record(bucket, probability, pass) {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('Invalid model probability');
  }
  const p = Math.min(1 - 1e-6, Math.max(1e-6, probability));
  bucket.n++;
  bucket.passed += pass;
  bucket.predicted += probability;
  bucket.logLoss -= pass ? Math.log(p) : Math.log1p(-p);
  bucket.brier += (probability - pass) ** 2;
}

let includedCards = 0;
let skippedCards = 0;
let skippedBeforeReset = 0;
for (const events of histories.values()) {
  events.sort((a, b) => a.ms - b.ms);
  const start = events.findLastIndex((event) => event.phase === 0);
  if (start === -1) {
    skippedCards++;
    continue; // Cannot reconstruct these histories from a known new/reset state.
  }
  includedCards++;
  skippedBeforeReset += start;
  let previous = null;
  let stateV6 = null;
  let stateV7 = null;
  for (const { ms, rating } of events.slice(start)) {
    const whole = previous == null ? 0 : logicalDaysBetween(previous, ms, ROLLOVER_HOUR, OFFSET_MINUTES);
    const fractional = previous == null ? 0 : (ms - previous) / DAY;
    const bucket = groups[whole === 0 ? 'sameDay' : 'crossDay'];
    if (stateV6 != null && stateV7 != null) {
      const pass = Number(rating >= 2);
      record(bucket.v6, powerForgettingCurve(whole, stateV6.stability), pass);
      record(bucket.v6Continuous, powerForgettingCurve(fractional, stateV6.stability), pass);
      record(bucket.v7, v7.curve(fractional, stateV7).retrievability, pass);
    }
    const answers = nextStates([], stateV6, TARGET, whole);
    const resultV6 = answers[['again', 'hard', 'good', 'easy'][rating - 1]];
    stateV7 = v7.next_state(stateV7, fractional, rating);
    stateV6 = resultV6.memory;
    if (previous != null) {
      const intervalV7 = v7.next_interval(stateV7, TARGET);
      bucket.intervalV6.push(resultV6.interval);
      bucket.intervalV7.push(intervalV7);
      bucket.ratio.push(intervalV7 / resultV6.interval);
    }
    previous = ms;
  }
}

const average = ({ n, passed, predicted, logLoss, brier }) => n === 0 ? null : ({
  n, actualRecall: passed / n, meanPredicted: predicted / n, logLoss: logLoss / n, brier: brier / n,
});
const quantiles = (values) => {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const get = (q) => values[Math.round(q * (values.length - 1))];
  return { p10: get(0.1), median: get(0.5), p90: get(0.9) };
};
console.log(JSON.stringify({
  totalRows, includedCards, skippedCards, skippedBeforeReset, skippedFiltered, target: TARGET,
  timezone: 'Asia/Shanghai', rolloverHour: ROLLOVER_HOUR,
  results: Object.fromEntries(Object.entries(groups).map(([key, b]) => [key, {
    v6: average(b.v6), v6Continuous: average(b.v6Continuous), v7: average(b.v7),
    rawIntervalDays: { v6: quantiles(b.intervalV6), v7: quantiles(b.intervalV7), ratioV7ToV6: quantiles(b.ratio) },
  }])),
}, null, 2));
