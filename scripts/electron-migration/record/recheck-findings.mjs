#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dispatch } from '../../../host/e2e/differential/ts-adapter.mjs';
import { textPart, imagePart } from '../../../host/plugins/chat-pipeline/src/microcompact.ts';
import { firstDifference } from './json.mjs';

// Reuse the original saved inputs and Rust-source expectations. Keep historical
// findings intact and write a separate post-main producer/decoder recheck report.
const source = JSON.parse(await readFile('fixtures/differential/static-findings.json', 'utf8'));
const results = [];
for (const finding of source.findings) {
  let actual;
  if (finding.lane === 'L02-llm-manager') {
    const response = await dispatch({ fn: 'tokens.estimate', args: { text: finding.text } });
    if (!response.ok) throw new Error(`production token call failed: ${JSON.stringify(response)}`);
    actual = response.value;
  } else if (finding.id === 'X7-L03-MULTIMODAL-TEXT-TAG') {
    actual = textPart(finding.expected.text);
  } else if (finding.id === 'X7-L03-MULTIMODAL-IMAGE-TAG') {
    actual = imagePart(finding.expected.mediaType, finding.expected.base64);
  } else {
    continue; // Other findings have separate targeted recheck scripts/reports.
  }
  const difference = firstDifference(finding.expected, actual);
  results.push({ id: finding.id, lane: finding.lane, source: finding.source,
    expected: finding.expected, actual, status: difference ? 'mismatch' : 'matches-static-expectation', difference });
}
if (results.length !== 5) throw new Error(`expected original three L02 and two L03 cases, found ${results.length}`);
const report = { kind: 'static-source-plus-production-recheck-not-C',
  rustBaseline: '2ee9a9cbeb2bff3d31748afdc3d951c166228f74',
  originalEvidenceRevision: source.revision,
  tsRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), results };
await writeFile('fixtures/differential/recheck-L02-L03.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = results.some(result => result.status === 'mismatch') ? 1 : 0;
