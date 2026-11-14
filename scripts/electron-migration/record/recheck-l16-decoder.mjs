#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { decodeAnkiCardInput, AnkiCardDecodeError } from '../../../host/plugins/anki/src/anki-cards.ts';

// The original finding is rejection of non-string values, not equality of raw
// serde_json Display positions and not an IPC bypass. Keep that scope explicit.
const original = JSON.parse(await readFile('fixtures/differential/static-findings.json', 'utf8'));
const selected = original.findings.filter(finding => finding.id.startsWith('X7-L16-SERDE-'));
if (selected.length !== 3) throw new Error('expected the original three L16 decoder probes');
const results = [];
for (const finding of selected) {
  let actual;
  try {
    const value = decodeAnkiCardInput(structuredClone(finding.input), () => {
      throw new Error('unexpected volatile default in the original fixed-ID/time probe');
    });
    actual = { ok: true, value };
  } catch (error) {
    if (!(error instanceof AnkiCardDecodeError)) throw error;
    actual = { ok: false, errorType: error.name, error: error.message };
  }
  results.push({ id: finding.id, lane: finding.lane, source: finding.source, scope: finding.scope,
    input: finding.input, expected: finding.expected, actual,
    status: actual.ok ? 'mismatch' : 'matches-static-rejection' });
}
const report = { kind: 'static-source-plus-production-recheck-not-C',
  rustBaseline: '2ee9a9cbeb2bff3d31748afdc3d951c166228f74',
  originalEvidenceRevision: original.revision,
  tsRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  scope: 'production decoder direct/internal composition; not IPC bypass or full serde error-wire parity', results };
await writeFile('fixtures/differential/recheck-L16-decoder.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = results.some(result => result.status === 'mismatch') ? 1 : 0;
