#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dispatch } from '../../../host/e2e/differential/ts-adapter.mjs';
import { firstDifference } from './json.mjs';

const original = JSON.parse(await readFile('fixtures/differential/cloze-boundary-findings.json', 'utf8'));
const vectors = JSON.parse(await readFile(original.vectors, 'utf8'));
if (original.findings.length !== 2) throw new Error('expected the original two L16 cloze probes');
const results = [];
for (const finding of original.findings) {
  const vector = vectors.find(value => value.id === finding.vectorId);
  if (!vector) throw new Error(`missing original vector: ${finding.vectorId}`);
  const response = await dispatch(vector);
  if (!response.ok) throw new Error(`production cloze call failed: ${JSON.stringify(response)}`);
  const value = response.value;
  // Compare precisely the original finding's observation; retain the complete
  // production response as evidence, without replacing the historical result.
  const actual = finding.id === 'X7-L16-OCCLUSION-IMAGE-TRIM'
    ? { ok: value.ok, issueCode: value.issues?.[0]?.code ?? null }
    : { text: value.value?.text ?? null };
  const difference = firstDifference(finding.expected, actual);
  results.push({ id: finding.id, lane: finding.lane, rust: finding.rust,
    input: vector, expected: finding.expected, actual, response,
    status: difference ? 'mismatch' : 'matches-static-expectation', difference });
}
const report = { kind: 'static-source-plus-production-recheck-not-C',
  rustBaseline: original.rustBaseline, originalEvidenceRevision: original.tsRevision,
  tsRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  scope: original.scope, results };
await writeFile('fixtures/differential/recheck-L16-cloze.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = results.some(result => result.status === 'mismatch') ? 1 : 0;
