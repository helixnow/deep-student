#!/usr/bin/env node
// Extracts real Rust (G3 A-side, Tauri build) JSON column values from a G3 DIFF-TRIAGE file
// into the serde-compat golden fixture. Only the A side is taken: `compareDatabaseStates(A, B)`
// stores A as `before` (host/e2e/data-compat/__fixtures__/database-state.ts:151-156).
//
// Usage: node scripts/serde-audit/g3-goldens.mjs <DIFF-TRIAGE.json[.gz]> [out.json]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT = path.join(ROOT, 'host/platform/serde-compat/tests/__fixtures__/g3-rust-samples.json');

/** db basename + table + column of columns whose Rust writer is pinned in the golden test. */
export const GOLDEN_COLUMNS = [
  ['vfs.db', 'files', 'processing_progress'],
  ['mistakes.db', 'anki_decks', 'config_json'],
  ['vfs.db', 'essays', 'dimension_scores_json'],
  ['vfs.db', 'exam_sheets', 'preview_json'],
  ['mistakes.db', 'custom_anki_templates', 'field_extraction_rules_json'],
  ['mistakes.db', 'document_tasks', 'anki_generation_options_json'],
];

export function readTriage(file) {
  const bytes = fs.readFileSync(file);
  const text = file.endsWith('.gz') ? zlib.gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
  return { text, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/** Every database difference (evidence + database samples) with its group, A value first. */
export function* databasePairs(triage) {
  for (const group of triage.groups ?? []) {
    const difference = group.evidence?.difference ?? {};
    const rows = [difference, ...(Array.isArray(difference.sample) ? difference.sample : [])];
    for (const row of rows) {
      if (row?.table === undefined || row.column === undefined) continue;
      yield { group, row, evidence: group.evidence };
    }
  }
}

const parses = (text) => {
  try { JSON.parse(text); return true; } catch { return false; }
};

export function extractGoldens(triage, triageSha256, triageName) {
  const samples = [];
  const taken = new Set();
  for (const { group, row, evidence } of databasePairs(triage)) {
    const db = String(row.db ?? '').split('/').pop();
    const wanted = GOLDEN_COLUMNS.find(([d, t, c]) => d === db && t === row.table && c === row.column);
    const value = row.before?.value;
    if (!wanted || row.before?.storageClass !== 'text' || typeof value !== 'string') continue;
    // Normalized placeholders such as `<n@...>` replace whole numbers and are not JSON.
    if (!parses(value) || taken.has(value)) continue;
    taken.add(value);
    samples.push({
      db, table: row.table, column: row.column, rust: value,
      provenance: { group: group.key, evidence: evidence?.file, evidenceSha256: evidence?.sha256, trace: evidence?.traces?.A?.file },
    });
  }
  samples.sort((a, b) => `${a.db}/${a.table}/${a.column}`.localeCompare(`${b.db}/${b.table}/${b.column}`) || a.rust.length - b.rust.length);
  return {
    schema: 'serde-compat-g3-rust-samples/v1',
    source: { file: triageName, sha256: triageSha256, side: 'A (Tauri/Rust)', at: triage.at },
    samples,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, out = DEFAULT_OUT] = process.argv.slice(2);
  if (!input) {
    console.error('usage: g3-goldens.mjs <DIFF-TRIAGE.json[.gz]> [out.json]');
    process.exit(2);
  }
  const { text, sha256 } = readTriage(input);
  const doc = extractGoldens(JSON.parse(text), sha256, path.basename(input));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`g3-goldens: ${doc.samples.length} Rust samples -> ${path.relative(ROOT, out)}`);
}
