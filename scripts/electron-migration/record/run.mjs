#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { JsonLineProcess } from './process.mjs';
import { firstDifference, parseExact, stringifyExact } from './json.mjs';

async function compareVectors(vectors, rust, ts, canonicalSerde) {
  const started = performance.now();
  const results = [];
  for (const vector of vectors) {
    const request = { fn: vector.fn, args: vector.args };
    let expected;
    try {
      expected = await rust.request(request);
      if (canonicalSerde && !vector.fn.startsWith('serde.')) throw new Error('canonical mode requires a serde function');
      // Canonical roundtrip feeds Rust's actual serialized sample into the real TS
      // decoder. This retains generated UUID/time defaults instead of masking them.
      const tsRequest = canonicalSerde && expected.ok
        ? { fn: vector.fn, args: { ...vector.args, json: stringifyExact(expected.value) } } : request;
      const actual = await ts(tsRequest);
      const difference = firstDifference(expected, actual);
      results.push({ id: vector.id, lane: vector.lane, fn: vector.fn, request,
        comparison: canonicalSerde && expected.ok ? 'rust-canonical-roundtrip' : 'same-input',
        rust: expected, ts: actual, status: difference ? 'fail' : 'pass', ...(difference && { difference }) });
    } catch (error) {
      // An unavailable production capability or harness error must never look like a matching Err.
      results.push({ id: vector.id, lane: vector.lane, fn: vector.fn, request,
        ...(expected !== undefined && { rust: expected }), status: 'blocked', reason: String(error) });
    }
  }
  return { kind: canonicalSerde ? 'serde-roundtrip' : 'pure-differential',
    durationMs: performance.now() - started, results, firstDifference: results.find(result => result.status === 'fail') ?? null };
}

export const runVectors = (vectors, rust, ts) => compareVectors(vectors, rust, ts, false);
export const runSerdeVectors = (vectors, rust, ts) => compareVectors(vectors, rust, ts, true);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [vectorsPath, binary, output, provenancePath] = process.argv.slice(2);
  if (!provenancePath) throw new Error('usage: run.mjs <vectors.json> <binary> <report.json> <build-provenance.json>');
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  if (!provenance.rustRevision || !provenance.buildJob) throw new Error('reference build provenance required');
  const { dispatch } = await import('../../../host/e2e/differential/ts-adapter.mjs');
  const rust = new JsonLineProcess([resolve(binary)]);
  try {
    const report = await runVectors(parseExact(await readFile(vectorsPath, 'utf8')), rust, dispatch);
    report.reference = provenance;
    report.tsRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await writeFile(output, stringifyExact(report, 2) + '\n');
    console.log(stringifyExact(report.firstDifference ?? { results: report.results.length, blocked: report.results.filter(r => r.status === 'blocked').length }));
    process.exitCode = report.results.some(result => result.status !== 'pass') ? 1 : 0;
  } finally { await rust.close(); }
}
