#!/usr/bin/env node
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { JsonLineProcess } from './process.mjs';
import { runVectors, runSerdeVectors } from './run.mjs';
import { parseExact, stringifyExact } from './json.mjs';
import { dispatch } from '../../../host/e2e/differential/ts-adapter.mjs';

const [binaryArg, provenancePath] = process.argv.slice(2);
if (!binaryArg || !provenancePath) throw new Error('usage: batch.mjs <built-binary> <build-provenance.json>');
const reference = JSON.parse(await readFile(provenancePath, 'utf8'));
if (!reference.rustRevision || !reference.buildJob || !reference.resolvedLock || reference.code !== 0) throw new Error('successful build provenance required');
const tsRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const out = `fixtures/differential/results/${reference.buildJob}/${runId}`;
await mkdir(out, { recursive: true });
await mkdir('fixtures/differential/runs', { recursive: true });
const isolated = await mkdtemp(resolve('fixtures/differential/runs/reference-'));
const rust = new JsonLineProcess([resolve(binaryArg)], { cwd: isolated,
  env: { ...process.env, XDG_DATA_HOME: isolated, XDG_CONFIG_HOME: isolated, XDG_CACHE_HOME: isolated } });
const files = ['vectors.json', 'crypto-vectors.json', 'boundary-vectors.json'];
const reports = [];
const corpus = [];
const started = performance.now();
const save = (name, value) => writeFile(join(out, name), stringifyExact(value, 2) + '\n');
try {
  for (const file of files) {
    const vectors = parseExact(await readFile(`fixtures/differential/${file}`, 'utf8'));
    corpus.push(...vectors);
    const report = await runVectors(vectors, rust, dispatch);
    Object.assign(report, { reference, tsRevision, vectors: `fixtures/differential/${file}` });
    reports.push(report);
    await save(file.replace('.json', '-results.json'), report);
  }

  const types = {
    'dstu_security::crypto::EncryptedData': ['serde.EncryptedData', 'F4-security'],
    'dstu_security::crypto::backup_crypto::PasswordVerifier': ['serde.PasswordVerifier', 'L23-sync-providers'],
    ...Object.fromEntries(['ChatMessage', 'ToolCall', 'ToolResult', 'RagSourceInfo', 'DocumentAttachment',
      'MultimodalContentPart', 'TempStreamState', 'AnkiCard'].map(name =>
      [`dstu_core::models::${name}`, [`serde.${name}`, name === 'AnkiCard' ? 'L16-anki' : 'F5-contracts']])),
  };
  const { inventory } = parseExact(await readFile('fixtures/differential/serde-inputs.json', 'utf8'));
  const serdeVectors = corpus.filter(vector => vector.fn.startsWith('serde.')).map(vector => ({ ...vector, id: `canonical:${vector.id}` }));
  const selectedTypes = [];
  for (const entry of inventory) {
    const target = types[entry.rust];
    if (!target) continue;
    selectedTypes.push({ file: entry.file, name: entry.name, rust: entry.rust });
    for (const item of entry.cases) serdeVectors.push({
      id: `contract:${entry.file}:${entry.name}:${item.axis}`, fn: target[0], lane: target[1],
      args: { json: stringifyExact(item.input) },
    });
  }
  const serde = await runSerdeVectors(serdeVectors, rust, dispatch);
  Object.assign(serde, { reference, tsRevision, candidateTypes: inventory.length, selectedTypes,
    deferredTypes: inventory.length - selectedTypes.length });
  reports.push(serde);
  await save('serde-results.json', serde);
  // Preserve actual Rust canonical samples/errors even if their TS codec is absent.
  await save('rust-serde-samples.json', serde.results.filter(result => result.rust).map(result => ({
    id: result.id, fn: result.fn, request: result.request, rust: result.rust,
  })));

  const count = rows => ({ pass: rows.filter(row => row.status === 'pass').length,
    diff: rows.filter(row => row.status === 'fail').length, blocked: rows.filter(row => row.status === 'blocked').length });
  const serdeOwners = new Map(Object.values(types));
  const all = reports.flatMap(report => report.results.map(result => ({ ...result,
    lane: serdeOwners.get(result.fn) ?? result.lane, evidenceKind: report.kind })));
  const byLane = {};
  for (const lane of [...new Set(all.map(row => row.lane))].sort()) {
    const rows = all.filter(row => row.lane === lane);
    byLane[lane] = { ...count(rows), differences: rows.filter(row => row.status === 'fail'),
      blockedCases: rows.filter(row => row.status === 'blocked').map(({ id, fn, reason }) => ({ id, fn, reason })) };
  }
  await save('by-lane.json', { reference, tsRevision, byLane });
  const units = {};
  for (const fn of [...new Set(all.map(row => row.fn))].sort()) {
    const rows = all.filter(row => row.fn === fn);
    const counts = count(rows);
    units[fn] = { ...counts, status: counts.diff ? 'fail' : counts.blocked ? 'blocked' : 'pass' };
  }
  const summary = { kind: 'first-batch-function-and-serde-evidence', reference, tsRevision,
    durationMs: performance.now() - started, ...count(all),
    datasets: reports.map(report => ({ kind: report.kind, vectors: report.vectors ?? 'serde-inputs + seed cases',
      durationMs: report.durationMs, ...count(report.results) })), units,
    serdeCoverage: { candidateTypes: inventory.length, selectedTypes, deferredTypes: inventory.length - selectedTypes.length } };
  await save('summary.json', summary);
  // Existing ledger --golden reads commands. Keep it empty: helper evidence is
  // real, but does not contain command returns + events + DB observations.
  await save('golden.json', { commands: {}, kind: 'function-and-serde-evidence-not-command-replay',
    reference, tsRevision, functionUnits: units, summary: `${out}/summary.json` });
  console.log(stringifyExact({ output: out, durationMs: summary.durationMs, pass: summary.pass, diff: summary.diff,
    blocked: summary.blocked, datasets: summary.datasets, serdeCoverage: summary.serdeCoverage }, 2));
  process.exitCode = summary.diff || summary.blocked ? 1 : 0;
} finally {
  try { await rust.close(); } finally { await rm(isolated, { recursive: true, force: true }); }
}
