import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { parseExact, stringifyExact, firstDifference, normalize } from '../../../scripts/electron-migration/record/json.mjs';
import { snapshot, databaseChanges } from '../../../scripts/electron-migration/record/database.mjs';
import { JsonLineProcess } from '../../../scripts/electron-migration/record/process.mjs';
import { runVectors, runSerdeVectors } from '../../../scripts/electron-migration/record/run.mjs';
import { goldenResults, replaySide } from '../../../scripts/electron-migration/record/replay.mjs';
import { createCommandHost } from './host-adapter.mjs';
import { scriptedProvider } from '../../../scripts/electron-migration/record/provider.mjs';
import { dispatch, Unavailable } from './ts-adapter.mjs';

function readScriptedResponse(url, bodyParts = []) {
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest(url, { method: bodyParts.length ? 'POST' : 'GET' }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.once('end', () => resolveResponse({ status: response.statusCode, body, aborted: false }));
      response.once('aborted', () => resolveResponse({ status: response.statusCode, body, aborted: true }));
      response.on('error', error => { if (!response.aborted) reject(error); });
    });
    request.once('error', reject);
    for (const part of bodyParts) request.write(part);
    request.end();
  });
}

test('D3 exact integers, unordered objects, ordered arrays, absent != null', () => {
  const a = parseExact('{"n":9223372036854775807,"list":[1,2]}');
  assert.equal(a.n, 9223372036854775807n);
  assert.equal(stringifyExact(a), '{"n":9223372036854775807,"list":[1,2]}');
  assert.equal(firstDifference(a, { list: [1, 2], n: 9223372036854775807n }), null);
  assert.equal(firstDifference(a, { list: [1, 2], n: 9223372036854775806n }).path, '/n');
  assert.equal(firstDifference([1, 2], [2, 1]).path, '/0');
  const long = Array(12).fill(0), changed = [...long]; changed[2] = 1; changed[10] = 1;
  assert.equal(firstDifference(long, changed).path, '/2');
  assert.equal(firstDifference({}, { field: null }).missing, 'expected');
  assert.equal(firstDifference({ x: 1.000001 }, { x: 1 }).path, '/x');
  // serde_json::Value uses arbitrary_precision: JS must not collapse distinct
  // exponential/fractional tokens before the oracle comparator sees them.
  assert.notEqual(firstDifference(parseExact('1e999'), parseExact('2e999')), null);
  assert.notEqual(firstDifference(parseExact('9007199254740993e0'), parseExact('9007199254740992e0')), null);
  assert.notEqual(firstDifference(parseExact('1.0000000000000000000001'), 1), null);
  assert.equal(firstDifference(parseExact('10e-1'), 1), null);
  assert.equal(firstDifference(parseExact('9007199254740993e0'), 9007199254740993n), null);
  assert.equal(stringifyExact(parseExact('[1e999,1.0000000000000000000001]')), '[1e999,1.0000000000000000000001]');
  assert.notEqual(firstDifference(parseExact('-0.0'), 0), null);
});

test('replay enters real kernel, preserves command-not-found error and leaves seed unchanged', async () => {
  await mkdir('fixtures/db', { recursive: true });
  const seed = await mkdtemp(resolve('fixtures/db/x7-replay-'));
  const db = new DatabaseSync(join(seed, 'test.db'));
  db.exec('CREATE TABLE fixture(id INTEGER PRIMARY KEY); INSERT INTO fixture VALUES(1)');
  db.close();
  try {
    const scenario = { snapshot: seed.split('/').at(-1), databases: ['test.db'], calls: [{ command: '__x7_missing_command', args: {} }] };
    const result = await replaySide(scenario, ({ dataDir }) => createCommandHost({
      dataDir, plugins: [], eventDrain: async () => {},
    }), 'ts');
    assert.equal(result.calls[0].outcome.ok, false);
    assert.match(String(result.calls[0].outcome.error), /__x7_missing_command/);
    assert.deepEqual(result.calls[0].changes, { 'test.db': {} });
    assert.equal(snapshot(join(seed, 'test.db')).tables.fixture.rows[0].id, 1n);
  } finally { await rm(seed, { recursive: true, force: true }); }
});

test('golden recomputes verdict and aggregates failures; empty/mislabeled sequences cannot promote C', () => {
  const run = { calls: [{ command: 'x', outcome: { ok: true, value: 1 }, events: [], changes: {} }], before: {}, after: {}, events: [], changes: {} };
  const report = { kind: 'command-replay', reference: { buildJob: 'test-only', rustRevision: 'test-only' }, tsRevision: 'test-only',
    commands: ['x'], rust: run, ts: run, status: 'pass' };
  assert.deepEqual(goldenResults([report]), { commands: { x: 'pass' } });
  const failed = { ...report, ts: { ...run, events: [{ name: 'extra' }] } };
  assert.deepEqual(goldenResults([failed, report]), { commands: { x: 'fail' } });
  assert.throws(() => goldenResults([{ ...report, commands: ['not-executed'] }]), /executed call sequence/);
  assert.throws(() => goldenResults([{ ...report, commands: [] }]), /executed call sequence/);
  for (const missing of ['before', 'after', 'changes', 'events']) {
    const incomplete = { ...run }; delete incomplete[missing];
    assert.throws(() => goldenResults([{ ...report, rust: incomplete, ts: incomplete }]), /missing replay evidence/);
  }
  for (const missing of ['outcome', 'events', 'changes']) {
    const call = { ...run.calls[0] }; delete call[missing];
    const incomplete = { ...run, calls: [call] };
    assert.throws(() => goldenResults([{ ...report, rust: incomplete, ts: incomplete }]), /missing command evidence/);
  }
  for (const outcome of [{}, { ok: true }, { ok: false }]) {
    const incomplete = { ...run, calls: [{ ...run.calls[0], outcome }] };
    assert.throws(() => goldenResults([{ ...report, rust: incomplete, ts: incomplete }]), /missing command evidence/);
  }
  // Explicit null is valid evidence; it must not be confused with absent output.
  for (const outcome of [{ ok: true, value: null }, { ok: false, error: null }]) {
    const complete = { ...run, calls: [{ ...run.calls[0], outcome }] };
    assert.deepEqual(goldenResults([{ ...report, rust: complete, ts: complete }]), { commands: { x: 'pass' } });
  }
});

test('only explicitly declared volatile pointers are masked; missing stays missing', () => {
  assert.deepEqual(normalize({ id: 'a', time: 'b', generation: 7 }, ['/time']), { id: 'a', time: '<volatile>', generation: 7n });
  assert.deepEqual(normalize({}, ['/time']), {});
});

test('SQLite snapshots sort composite PK and preserve i64/blob; detect foreign table writes', async () => {
  await mkdir('fixtures/differential/runs', { recursive: true });
  const root = await mkdtemp(resolve('fixtures/differential/runs/db-'));
  const path = join(root, 'fixture.db');
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE t(a TEXT,b INTEGER,n INTEGER,p BLOB,stamp TEXT,PRIMARY KEY(a,b)); INSERT INTO t VALUES('z',2,9223372036854775807,x'00ff','now'),('a',1,1,x'','then'); CREATE TABLE foreign_lane(id INTEGER PRIMARY KEY)");
    const before = snapshot(path, { t: { volatile: ['/stamp'] } });
    assert.equal(before.tables.t.rows[0].a, 'a');
    assert.equal(before.tables.t.rows[1].n, 9223372036854775807n);
    assert.deepEqual(before.tables.t.rows[1].p, { sqliteBlobHex: '00ff' });
    db.exec("UPDATE t SET stamp='later'; INSERT INTO foreign_lane VALUES(9)");
    const changes = databaseChanges(before, snapshot(path, { t: { volatile: ['/stamp'] } }));
    assert.deepEqual(Object.keys(changes), ['tables']);
    assert.deepEqual(Object.keys(changes.tables), ['foreign_lane']);
    const timestampOnly = snapshot(path, { t: { volatile: ['/stamp'] } });
    db.exec('UPDATE t SET stamp=NULL');
    assert.deepEqual(databaseChanges(timestampOnly, snapshot(path, { t: { volatile: ['/stamp'] } })), {});
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test('SQLite replay detects schema, AUTOINCREMENT and storage-class changes even when application rows match', async () => {
  await mkdir('fixtures/differential/runs', { recursive: true });
  const root = await mkdtemp(resolve('fixtures/differential/runs/state-'));
  const path = join(root, 'fixture.db');
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT); CREATE TABLE storage(v); INSERT INTO storage VALUES(1)');
    const before = snapshot(path);
    db.exec(`CREATE INDEX records_value ON records(value);
      CREATE TRIGGER upper_record AFTER INSERT ON records BEGIN UPDATE records SET value=upper(value) WHERE id=NEW.id; END;
      CREATE VIEW visible_records AS SELECT id,value FROM records;
      INSERT INTO records(value) VALUES('x'); DELETE FROM records;
      DELETE FROM storage; INSERT INTO storage VALUES(1.0);
      PRAGMA user_version=7; PRAGMA application_id=1234;`);
    const after = snapshot(path);
    assert.deepEqual(after.tables.records.rows, before.tables.records.rows);
    assert.deepEqual(after.tables.storage.rows, before.tables.storage.rows);
    assert.equal(before.tables.storage.storageClasses[0].v, 'integer');
    assert.equal(after.tables.storage.storageClasses[0].v, 'real');
    assert.equal(after.tables.sqlite_sequence.rows[0].seq, 1n);
    const changes = databaseChanges(before, after);
    assert.deepEqual(Object.keys(changes.tables).sort(), ['sqlite_sequence', 'storage']);
    assert.equal(changes.metadata.after.userVersion, 7);
    assert.equal(changes.metadata.after.applicationId, 1234);
    for (const [type, name] of [['index', 'records_value'], ['trigger', 'upper_record'], ['view', 'visible_records']]) {
      assert.ok(changes.schema.after.some(item => item.type === type && item.name === name));
    }
    // No PK: insertion order of equal numeric values with different storage
    // classes must not create noise in a normalized snapshot.
    db.exec('DELETE FROM storage; INSERT INTO storage VALUES(1),(1.0)');
    const ordered = snapshot(path);
    db.exec('DELETE FROM storage; INSERT INTO storage VALUES(1.0),(1)');
    assert.equal(firstDifference(ordered, snapshot(path)), null);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test('JSONL oracle is reused; invalid output and crash cannot become matching application errors', async () => {
  const command = [process.execPath, '-e', `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);console.log(JSON.stringify({ok:true,value:r.args}))})`];
  const processOracle = new JsonLineProcess(command);
  try {
    assert.deepEqual(await processOracle.request({ fn: 'echo', args: { n: 1 } }), { ok: true, value: { n: 1n } });
    assert.deepEqual(await processOracle.request({ fn: 'echo', args: 2 }), { ok: true, value: 2n });
  } finally { await processOracle.close(); }
  const broken = new JsonLineProcess([process.execPath, '-e', `process.stdin.once('data',()=>console.log('diagnostic on stdout'))`]);
  try { await assert.rejects(broken.request({ fn: 'bad', args: {} })); }
  finally { await broken.close(); }
});

test('unavailable adapter stays blocked and first mismatch retains lane and JSON pointer', async () => {
  const report = await runVectors([{ id: '1', lane: 'L', fn: 'f', args: {} }],
    { request: async () => ({ ok: true, value: { n: 1 } }) }, async () => ({ ok: true, value: { n: 2 } }));
  assert.equal(report.firstDifference.difference.path, '/value/n');
  assert.equal(report.firstDifference.lane, 'L');
  assert.deepEqual(report.results[0].rust, { ok: true, value: { n: 1 } });
  assert.deepEqual(report.results[0].ts, { ok: true, value: { n: 2 } });
  const blocked = await runVectors([{ id: '2', fn: 'absent', args: {} }],
    { request: async () => ({ ok: true, value: null }) }, dispatch);
  assert.equal(blocked.results[0].status, 'blocked');
  assert.deepEqual(blocked.results[0].rust, { ok: true, value: null });
  assert.throws(() => goldenResults([report]), /only provenance-backed/);
  const canonical = { front: 'f', back: 'b', text: null, tags: [], images: [], id: 'reference-generated',
    task_id: '', is_error_card: false, error_content: null, created_at: '2026-11-04T00:00:00Z',
    updated_at: '2026-11-04T00:00:00Z', extra_fields: {}, template_id: null };
  const roundtrip = await runSerdeVectors([{ id: 'canonical', fn: 'serde.AnkiCard', args: { json: '{}' } }],
    { request: async () => ({ ok: true, value: canonical }) }, dispatch);
  assert.equal(roundtrip.kind, 'serde-roundtrip');
  assert.equal(roundtrip.results[0].status, 'pass');
  assert.equal(roundtrip.results[0].comparison, 'rust-canonical-roundtrip');
  assert.equal(roundtrip.results[0].request.args.json, '{}');
  assert.deepEqual(roundtrip.results[0].ts.value, canonical);
});

test('production TS adapters run actual modules for Unicode, serde, digest and chunking', async () => {
  assert.deepEqual(await dispatch({ fn: 'text.safe_truncate', args: { text: '中🙂a', maxChars: 2 } }), { ok: true, value: '中🙂...' });
  assert.deepEqual(await dispatch({ fn: 'serde.EncryptedData', args: { json: '["a","b"]' } }), { ok: true, value: { ciphertext: 'a', nonce: 'b', version: null } });
  assert.deepEqual(await dispatch({ fn: 'crypto.staticKey', args: { seed: 'builtin-seed' } }), { ok: true, value: '33fd6c29c00b63739e7cdbf88abb3e22ed824390ee7516bd196c1164ef2fc134' });
  assert.deepEqual(await dispatch({ fn: 'embedding.chunk', args: { text: 'hi', maxTokens: 10, overlap: 0 } }), { ok: true, value: ['hi'] });
  assert.deepEqual(await dispatch({ fn: 'time.utc', args: { text: 'not a timestamp', useZ: true } }), { ok: true, value: null });
  assert.deepEqual(await dispatch({ fn: 'time.utc', args: { text: '', useZ: false } }), { ok: true, value: null });
  assert.deepEqual(await dispatch({ fn: 'regex.projected', args: { pattern: 'x', text: 'x', replacement: 'y', limit: 1 } }),
    { ok: true, value: { ok: true, value: 'y', bytes: 1 } });
  assert.deepEqual(await dispatch({ fn: 'regex.projected', args: { pattern: '(x)', text: 'xx', replacement: '$1$1', limit: 1 } }),
    { ok: true, value: { ok: false, bytes: 2 } });
  await assert.rejects(dispatch({ fn: '__x7_unpublished_function', args: {} }), Unavailable);

  const verifier = { kdf: 'argon2id', mCost: 32, tCost: 1, pCost: 1, salt: 'salt', digest: 'digest' };
  assert.deepEqual(await dispatch({ fn: 'serde.PasswordVerifier', args: { json: JSON.stringify({ ...verifier, unknown: true }) } }),
    { ok: true, value: verifier });
  assert.deepEqual(await dispatch({ fn: 'serde.PasswordVerifier', args: { json: JSON.stringify(Object.values(verifier)) } }),
    { ok: true, value: verifier });
  const missing = await dispatch({ fn: 'serde.PasswordVerifier', args: { json: '{"kdf":"argon2id"}' } });
  assert.equal(missing.ok, false);
  // This is the published decoder's error, not a claim of Rust Display parity.
  assert.equal(missing.error, 'missing field `mCost` at line 1 column 18');
  const overflow = await dispatch({ fn: 'serde.PasswordVerifier', args: { json: JSON.stringify({ ...verifier, mCost: 4294967296 }) } });
  assert.equal(overflow.ok, false);
  assert.match(overflow.error, /expected u32/);
});

test('scripted external provider checks ordered request bodies and consumes error/retry/SSE script', async () => {
  const request = { method: 'POST', path: '/v1/chat/completions', body: { model: 'fixture' } };
  const provider = await scriptedProvider([
    { request, status: 429, chunks: ['{"error":"retry"}'] },
    { request, headers: { 'content-type': 'text/event-stream' }, chunks: ['data: {"choices":[]}\n\n', 'data: [DONE]\n\n'] },
  ]);
  try {
    const send = () => fetch(provider.url + request.path, { method: 'POST', body: JSON.stringify(request.body) });
    assert.equal((await send()).status, 429);
    assert.equal(await (await send()).text(), 'data: {"choices":[]}\n\ndata: [DONE]\n\n');
    provider.assertConsumed();
  } finally { await provider.close(); }
});

test('scripted provider preserves UTF-8 request text split across HTTP chunks', async () => {
  const body = { text: '中文🙂' };
  const provider = await scriptedProvider([{ request: { method: 'POST', path: '/json', body }, chunks: ['{"ok":true}'] }]);
  try {
    const bytes = Buffer.from(JSON.stringify(body));
    const split = bytes.indexOf(Buffer.from('中')) + 1;
    const response = await readScriptedResponse(provider.url + '/json', [bytes.subarray(0, split), bytes.subarray(split)]);
    assert.deepEqual(response, { status: 200, body: '{"ok":true}', aborted: false });
    provider.assertConsumed();
    assert.deepEqual(provider.requests[0].body, body);
  } finally { await provider.close(); }
});

test('scripted provider delivers prefix before a mid-stream disconnect', async () => {
  const prefix = 'data: {"delta":"中文🙂"}\n\n';
  const provider = await scriptedProvider([{ request: { method: 'GET', path: '/stream', body: null },
    headers: { 'content-type': 'text/event-stream' }, chunks: [prefix], disconnect: true }]);
  try {
    const response = await readScriptedResponse(provider.url + '/stream');
    assert.deepEqual(response, { status: 200, body: prefix, aborted: true });
    provider.assertConsumed();
  } finally { await provider.close(); }
});
