#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { dispatch } from '../../../host/e2e/differential/ts-adapter.mjs';
import { parseExact, stringifyExact } from './json.mjs';

// TS availability/production-entrypoint exercise only. This never produces pass/C.
const selected = process.argv[2] === 'all' ? undefined : process.argv[2];
const vectorPath = process.argv[3] ?? 'fixtures/differential/vectors.json';
const allVectors = parseExact(await readFile(vectorPath, 'utf8'));
const vectors = selected ? allVectors.filter(vector => vector.fn === selected) : allVectors;
if (!vectors.length) throw new Error(`no vectors for ${selected}`);
const results = [];
for (const vector of vectors) {
  try { results.push({ id: vector.id, lane: vector.lane, fn: vector.fn, status: 'ts-executed', response: await dispatch(vector) }); }
  catch (error) { results.push({ id: vector.id, lane: vector.lane, fn: vector.fn, status: 'blocked', reason: String(error) }); }
}
const byFunction = {};
for (const result of results) {
  const group = byFunction[result.fn] ??= { executed: 0, blocked: 0 };
  group[result.status === 'blocked' ? 'blocked' : 'executed']++;
}
await mkdir('fixtures/differential/reports', { recursive: true });
const dataset = process.argv[3] ? `-${basename(vectorPath, '.json')}` : '';
await writeFile(`fixtures/differential/reports/ts-preflight${dataset}${selected ? `-${selected}` : ''}.json`, stringifyExact({ kind: 'ts-only-not-golden',
  vectors: vectorPath, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), byFunction, results }, 2) + '\n');
console.log(stringifyExact(byFunction, 2));
