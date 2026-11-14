#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { stringifyExact } from './json.mjs';

// More inputs for the frozen 34 IDs; no reference functions or expected outputs.
// Seeded and bounded: at most 13 occlusion boxes and no expensive valid KDF params.
let state = 0x583734;
const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
const pick = values => values[random() % values.length];
const vectors = [];
const add = (id, lane, fn, args) => vectors.push({ id: `boundary:${id}`, lane, fn, args });

for (let i = 0; i < 64; i++) {
  add(`fsrs:${i}`, 'L15-review-analytics', 'fsrs.schedule', {
    parameters: pick([[], [0.5], Array(17).fill(0.5)]),
    card: {
      phase: pick(['new', 'learning', 'review', 'relearning']),
      memory: pick([null, { stability: 0, difficulty: 5 }, { stability: 4, difficulty: 0 }, { stability: 4, difficulty: 5 }]),
      learningStep: pick([0, 1, 4, 4294967295]), daysElapsed: pick([0, 1, 30, 3650]),
      reps: pick([0, 7, 2147483647]), lapses: pick([0, 3, 2147483647]),
    },
    context: { desiredRetention: pick([0.7, 0.9, 0.99]), learningSteps: pick([[], [1], [1, 10], [1440, 2880]]),
      relearningSteps: pick([[], [10]]), maximumInterval: pick([1, 2, 36500]), fuzzFactor: pick([null, 0, 0.5, 0.999999]) },
  });
}
for (const [index, interval] of [2.499999, 2.5, 2.500001, 6.999999, 7, 7.000001, 19.999999, 20, 20.000001].entries()) {
  for (const factor of [null, 0, 0.5, 0.999999]) add(`fuzz:${index}:${factor}`, 'L15-review-analytics', 'fsrs.fuzz', {
    interval, factor, minimum: 1, maximum: 36500,
  });
}

const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: 'fixture' };
const specs = [
  { imageRef: '', boxes: [box] }, { imageRef: '\u0085', boxes: [box] },
  { imageRef: 'vfs://fixture', boxes: [] },
  { imageRef: 'vfs://fixture', boxes: Array.from({ length: 13 }, () => ({ ...box })) },
  ...[-0.000002, -0.000001, 0, 0.8, 0.800002].map(x => ({ imageRef: 'vfs://fixture', boxes: [{ ...box, x }] })),
  ...[0, 0.009999, 0.01, 0.010001].map(w => ({ imageRef: 'vfs://fixture', boxes: [{ ...box, w }] })),
  ...[0, 1, 4294967295].map(clozeIndex => ({ imageRef: 'vfs://fixture', boxes: [{ ...box, clozeIndex }] })),
  ...['', ' '.repeat(5), '\u0085', '中🙂'.repeat(30), 'A::B}}C'].map(label => ({ imageRef: 'vfs://fixture', boxes: [{ ...box, label }] })),
  { imageRef: 'vfs://fixture', boxes: [box, { ...box, x: 0.15 }] },
];
for (const [index, spec] of specs.entries()) add(`cloze:${index}`, 'L16-anki', 'cloze.fields', {
  spec, imageFileName: null, extraNote: null,
});

for (const [index, text] of ['', 'not a timestamp', '2024-02-29T23:59:59.999999999-05:30',
  '2026-11-04T00:00:00.000001+14:00', '2016-12-31T23:59:60Z', '2026-11-04T00:00:00-00:00'].entries()) {
  for (const useZ of [true, false]) add(`utc:${index}:${useZ}`, 'F4-security', 'time.utc', { text, useZ });
}

const crypto = JSON.parse(await readFile('fixtures/differential/crypto-vectors.json', 'utf8'));
const verifier = crypto.find(vector => vector.id === 'crypto-input:0:verifier').args;
const invalidFields = [
  { kdf: 'unknown' }, { salt: 'abc' }, { salt: 'zz' }, { salt: '00'.repeat(7) },
  { digest: 'zz' }, { digest: '00'.repeat(31) }, { mCost: 1 }, { mCost: 4294967295 },
  { tCost: 0 }, { tCost: 17 }, { pCost: 0 }, { pCost: 9 },
];
for (const [index, fields] of invalidFields.entries()) add(`verifier:${index}`, 'F4-security', 'crypto.checkVerifier', {
  password: verifier.password, verifier: { ...verifier.verifier, ...fields },
});

await writeFile('fixtures/differential/boundary-vectors.json', stringifyExact(vectors, 2) + '\n');
console.log(`prepared ${vectors.length} bounded inputs, seed 0x583734; existing Rust IDs only`);
