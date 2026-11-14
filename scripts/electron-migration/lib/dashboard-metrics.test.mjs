import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as m from './dashboard-metrics.mjs';

const MIN = 60_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dash-metrics-'));

test('ledger stdout: B-test / B-doc parsed from the W09 format, null on the pre-split format', () => {
  const now = 'ledger: commands 1058 (A 99.9% B 0% C 0%; B-test 52% B-doc 0%), tests 2310 (A 81.2% B 64.5%); problems: commands 3, tests 9, orphan registrations 0; kernel ok';
  assert.deepEqual(m.parseLedgerLine(now), { commands: 1058, cmdA: 99.9, cmdB: 0, cmdC: 0, cmdBTest: 52, cmdBDoc: 0, tests: 2310, testA: 81.2, testB: 64.5 });
  const old = 'ledger: commands 1058 (A 99.8% B 0% C 0%), tests 2310 (A 80% B 60%); problems: commands 3';
  assert.equal(m.parseLedgerLine(old).cmdBTest, null);
  assert.equal(m.parseLedgerLine(old).cmdA, 99.8);
  assert.equal(m.parseLedgerLine('something else'), null);
});

test('LEDGER.md lane rows: trailing B-test / B-doc columns, any lane prefix, old 8-column rows still parse', () => {
  const md = [
    '| Lane | 命令 | A | B（兼容） | C | 测试 | 测试 A | 测试 B | B-test | B-doc |',
    '|---|---|---|---|---|---|---|---|---|---|',
    '| L04-chat-runtime | 40 | 100% | 0% | 0% | 120 | 90.5% | 70% | 62.5% | 0% |',
    '| P3-gates-ledger | 2 | 50% | 0% | 0% | 0 | 0% | 0% | 0% | 0% |',
    '| L20b-sync-support | 7 | 100% | 0% | 0% | 3 | 100% | 33.3% |',
  ].join('\n');
  const lanes = m.parseLedgerMd(md);
  assert.deepEqual(Object.keys(lanes), ['L04-chat-runtime', 'P3-gates-ledger', 'L20b-sync-support']);
  assert.deepEqual(lanes['L04-chat-runtime'], { cmd: 40, cmdA: 100, cmdB: 0, cmdC: 0, tests: 120, testA: 90.5, testB: 70, cmdBTest: 62.5, cmdBDoc: 0 });
  assert.equal(lanes['L20b-sync-support'].cmdBTest, null);
});

test('event-emit --json and the agent-tool-coverage line become gap counts; anything else is "not measured"', () => {
  const json = JSON.stringify({ gate: 'event-emit', findings: [], summary: { listeners: 90, emitters: 400, dynamicEmitters: 3, existing: 21, unemitted: 13, dynamic: 8, baselined: 21, fresh: 0, stale: 0 } });
  assert.deepEqual(m.parseEventEmit(json), { existing: 21, unemitted: 13, dynamic: 8, fresh: 0, stale: 0 });
  assert.equal(m.parseEventEmit('event-emit: 90 listen sites …'), null);
  assert.equal(m.parseEventEmit('{"gate":"frontend-invoke","summary":{}}'), null);
  const out = 'stdout | host/e2e/coverage/agent-tool-coverage.test.ts > …\nagent-tool-coverage: 336 frontend tools, 53 executors (Note, Search); 118 uncovered\n  attachment-tools: 2 — a, b';
  assert.deepEqual(m.parseToolCoverage(out), { tools: 336, executors: 53, uncovered: 118 });
  assert.equal(m.parseToolCoverage('Test Files 1 failed'), null);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ entries: [{ tool: 'a' }, { tool: 'b' }] }));
  assert.equal(m.baselineCount(path.join(dir, 'b.json')), 2);
  assert.equal(m.baselineCount(path.join(dir, 'missing.json')), null);
});

test('G3: only a sealed formal recording yields a pass rate; missing, foreign or defective reports are "not measured", never 0', () => {
  const dir = tmp();
  const file = path.join(dir, 'g3-report.json');
  const report = { schema: 'g3-report-v1', head: 'abc123def456', totals: { pass: 0, fail: 10, 'no-scenario': 758, blocked: 0, excluded: 0 }, passRate: { pass: 0, of: 768, percent: 0 }, recording: { file: 'RECORDING.json', defects: [] } };
  assert.equal(m.readG3(file).measured, false);
  assert.match(m.readG3(file).reason, /未找到/);
  fs.writeFileSync(file, '{not json');
  assert.equal(m.readG3(file).measured, false);
  fs.writeFileSync(file, JSON.stringify({ ...report, schema: 'g2-report' }));
  assert.equal(m.readG3(file).measured, false);
  fs.writeFileSync(file, JSON.stringify({ ...report, recording: { file: null, defects: [] } }));
  assert.match(m.readG3(file).reason, /正式录制/);
  fs.writeFileSync(file, JSON.stringify({ ...report, recording: { file: 'RECORDING.json', defects: [{ kind: 'unattributable-recording' }] } }));
  assert.match(m.readG3(file).reason, /缺陷 1/);
  fs.writeFileSync(file, JSON.stringify({ ...report, passRate: { pass: 'x', of: 0 } }));
  assert.equal(m.readG3(file).measured, false);
  fs.writeFileSync(file, JSON.stringify(report));
  const ok = m.readG3(file);
  assert.equal(ok.measured, true);
  assert.deepEqual([ok.pass, ok.of, ok.percent, ok.head], [0, 768, 0, 'abc123def']);
});

test('WORKPLAN rows parse the same columns coord.mjs reads', () => {
  const md = '| 编号 | lane | a | b | c | 状态 | 备注 |\n| WP-2001 | L20 | x | y | z | delivered | |\n| WP-FE-A4 | P3 | x | y | z | assigned | |';
  assert.deepEqual(m.parseWorkplan(md), [{ id: 'WP-2001', lane: 'L20', status: 'delivered' }, { id: 'WP-FE-A4', lane: 'P3', status: 'assigned' }]);
});

const NOW = Date.parse('2026-11-07T12:00:00Z');
const at = (min) => new Date(NOW - min * MIN).toISOString();
const base = { history: [], nudges: [], deliveries: [], workplan: [], zeroMerge: { streak: 0, rounds: 5 }, nowMs: NOW };
const byId = (list) => Object.fromEntries(list.map((c) => [c.id, c]));

test('spin criteria: six rules, C2-judged rule stays manual, missing inputs are "unknown" not "clear"', () => {
  const c = byId(m.spinCriteria({ ...base, history: null, zeroMerge: null }));
  assert.deepEqual(Object.keys(c).map(Number), [1, 2, 3, 4, 5, 6]);
  assert.equal(c[1].state, 'unknown');
  assert.equal(c[2].state, 'unknown');
  assert.equal(c[3].state, 'manual');
  assert.equal(c[5].state, 'unknown');
  for (const x of Object.values(c)) assert.ok(x.label.length > 4, x.id);
});

test('spin 1: idle-spin in two consecutive two-hour windows; one window or a stale snapshot does not count', () => {
  const history = [
    { at: at(125), verdicts: { 'L04-chat': 'idle-spin', 'L06-agent': 'idle-spin' } },
    { at: at(60), verdicts: { 'L04-chat': 'producing', 'L06-agent': 'idle-spin' } },
    { at: at(3), verdicts: { 'L04-chat': 'idle-spin', 'L06-agent': 'producing', 'L17-memory': 'doc-spin' } },
  ];
  const c = byId(m.spinCriteria({ ...base, history }));
  assert.equal(c[1].state, 'hit');
  assert.deepEqual(c[1].lanes, ['L04-chat']);
  assert.equal(c[2].state, 'hit');
  assert.deepEqual(c[2].lanes, ['L17-memory']);
  assert.equal(byId(m.spinCriteria({ ...base, history: history.slice(1) }))[1].state, 'unknown', 'no snapshot two hours back yet');
  const stale = history.map((h) => ({ ...h, at: new Date(Date.parse(h.at) - 60 * MIN).toISOString() }));
  assert.equal(byId(m.spinCriteria({ ...base, history: stale }))[1].state, 'unknown', 'coord-reports timer stopped');
});

test('spin 4/5/6: repeat delivery not accepted, zero-merge streak with a delivered backlog, nudge-gate refusals', () => {
  const deliveries = [{ wp: 'WP-2011', lane: 'L06', at: at(200) }, { wp: 'WP-2011', lane: 'L06', at: at(30) }, { wp: 'WP-2001', lane: 'L20', at: at(90) }, { wp: 'WP-2001', lane: 'L20', at: at(10) }];
  const workplan = [{ id: 'WP-2011', lane: 'L06', status: 'assigned' }, { id: 'WP-2001', lane: 'L20', status: 'integrated' }, ...['a', 'b', 'c', 'd', 'e'].map((x) => ({ id: `WP-9${x}`, lane: 'X', status: 'delivered' }))];
  const nudges = [
    ...[100, 50, 10].map((min) => ({ t: at(min), from: 'C1-app', to: 'L04', topics: ['催办'], blocked: 'similar' })),
    ...[300, 50, 10].map((min) => ({ t: at(min), from: 'C2-platform', to: 'L06', topics: ['集成'], blocked: 'similar' })),
    { t: at(5), from: 'C2-platform', to: 'L06', topics: ['集成'] },
  ];
  const c = byId(m.spinCriteria({ ...base, history: [{ at: at(130), verdicts: {} }, { at: at(2), verdicts: {} }], deliveries, workplan, nudges, zeroMerge: { streak: 3, rounds: 9 } }));
  assert.equal(c[4].state, 'hit');
  assert.deepEqual(c[4].lanes, ['L06']);
  assert.match(c[4].detail, /WP-2011/);
  assert.equal(c[5].state, 'hit');
  assert.equal(c[6].state, 'hit');
  assert.deepEqual(c[6].lanes, ['C1-app']);
  const calm = byId(m.spinCriteria({ ...base, history: [{ at: at(130), verdicts: {} }, { at: at(2), verdicts: {} }], workplan: workplan.slice(0, 3), zeroMerge: { streak: 3, rounds: 9 } }));
  assert.equal(calm[5].state, 'clear', 'zero merges without a delivered backlog is not spin');
  assert.equal(calm[4].state, 'clear');
  assert.equal(calm[6].state, 'clear');
});

test('coord wp-done records every delivery in an append-only log (the report file itself is overwritten)', () => {
  const src = fs.readFileSync(new URL('../coord.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf("cmd === 'wp-done'"), src.indexOf("cmd === 'release-lock'"));
  assert.match(body, /appendFileSync\(path\.join\(board, 'deliveries\.jsonl'\), `\$\{JSON\.stringify\(\{ wp, lane, tip, at: deliveredAt \}\)\}\\n`\)/);
});

test('readJsonl tolerates a truncated last line and missing files', () => {
  const dir = tmp();
  const f = path.join(dir, 'x.jsonl');
  assert.equal(m.readJsonl(f), null);
  fs.writeFileSync(f, '{"a":1}\n{"a":2}\n{"a":');
  assert.deepEqual(m.readJsonl(f), [{ a: 1 }, { a: 2 }]);
});
