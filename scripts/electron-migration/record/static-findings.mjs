#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { dispatch } from '../../../host/e2e/differential/ts-adapter.mjs';
import { textPart, imagePart } from '../../../host/plugins/chat-pipeline/src/microcompact.ts';
import { execFileSync } from 'node:child_process';

// Expected counts follow the cited Rust branch directly, not an emulated Rust algorithm.
const probes = [
  { id: 'X7-L02-HANGUL-A', text: '\ua960'.repeat(3), expected: 3, source: 'dstu-util/src/utils/token_budget.rs:173' },
  { id: 'X7-L02-HANGUL-B', text: '\ud7b0'.repeat(3), expected: 3, source: 'dstu-util/src/utils/token_budget.rs:174' },
  { id: 'X7-L02-HANGUL-COMPAT', text: '\u3130'.repeat(3), expected: 2, source: 'dstu-util/src/utils/token_budget.rs:170-174,28' },
];
const findings = [];
for (const probe of probes) {
  const actual = await dispatch({ fn: 'tokens.estimate', args: { text: probe.text } });
  findings.push({ ...probe, lane: 'L02-llm-manager', actual, mismatch: actual.ok !== true || actual.value !== probe.expected });
}
const fixed = { id: 'fixture', created_at: '2026-11-04T00:00:00Z', updated_at: '2026-11-04T00:00:00Z' };
for (const [field, value] of [['front', 3], ['tags', [3]], ['extra_fields', { key: 3 }]]) {
  const input = { ...fixed, [field]: value };
  findings.push({ id: `X7-L16-SERDE-${field}`, lane: 'L16-anki', source: 'dstu-core/src/models.rs:1380-1411',
    scope: 'production decoder direct call / internal assembly; not an IPC contract bypass',
    input, expected: 'serde rejects a non-string value in String / Vec<String> / HashMap<String,String>',
    actual: await dispatch({ fn: 'serde.AnkiCard', args: { json: JSON.stringify(input) } }) });
}
findings.push({ id: 'X7-L03-MULTIMODAL-TEXT-TAG', lane: 'L03-chat-pipeline',
  source: 'dstu-core/src/models.rs:107-123 (serde tag=type, rename_all=lowercase)',
  expected: { type: 'text', text: 'fixture' }, actual: textPart('fixture') });
findings.push({ id: 'X7-L03-MULTIMODAL-IMAGE-TAG', lane: 'L03-chat-pipeline',
  source: 'dstu-core/src/models.rs:107-123 (image_url rename, mediaType field rename)',
  expected: { type: 'image_url', mediaType: 'image/png', base64: 'AA==' }, actual: imagePart('image/png', 'AA==') });
const report = { kind: 'static-source-vs-production-not-C',
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), findings };
await writeFile('fixtures/differential/static-findings.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
