import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyApprovals, loadApprovals, scan } from './unchecked-decode.mjs';

test('as, angle assertions and double assertions are detected structurally', () => {
  const hits = scan('a.ts', 'const a = (JSON.parse(s)) as T; const b = <T>JSON.parse(s); const c = input as unknown as T; const d = JSON.parse(s) as unknown as T;');
  assert.deepEqual(hits.map(f => [f.rule, f.severity]), [
    ['json-parse-assertion', 'error'], ['json-parse-assertion', 'error'], ['double-assertion', 'info'], ['json-parse-assertion', 'error'],
  ]);
});
test('unknown intermediate, actual decoder call, strings and comments are not violations', () => {
  assert.deepEqual(scan('a.ts', 'const v: unknown = JSON.parse(s); const u = JSON.parse(s) as unknown; const a = decode(JSON.parse(s)); // JSON.parse(s) as T\nconst text = "as unknown as T";'), []);
});
test('raw IPC destructure differs from kernel contract-decoded handlers', () => {
  const text = 'ipcMain.handle("x", (_e, {x}) => x); ipcMain.on("y", (_e, args) => { const {y} = args as T; }); ctx.commands.register("ok", ({x})=>x); ipcMain.handle("ok", (_e, args)=> { const {x}=decode(args); return x; });';
  assert.equal(scan('a.ts', text).filter(f => f.rule === 'raw-ipc-destructure').length, 2);
});
test('preceding manual validation is not falsely certified or blocked', () => {
  assert.deepEqual(scan('a.ts', 'ipcMain.handle("x", (_e, args) => { assertArgs(args); const {x}=args; });'), []);
});
test('approval binds one expression in one function; new/edited parses in the same file or function still reported', () => {
  const file = 'host/plugins/p/src/reader.ts';
  const approved = { path: file, function: 'JsonReader.string', rule: 'json-parse-assertion', expression: 'JSON.parse(this.text.slice(start, this.offset))  as string', approvedBy: 'R2', evidence: 'x' };
  const approvals = loadApprovals(JSON.stringify({ approvals: [approved] }));
  const base = 'class JsonReader { string() { return JSON.parse(this.text.slice(start, this.offset)) as string; } }';
  assert.deepEqual(applyApprovals(scan(file, base), approvals), []);
  // same file, new business parse in another function
  const sameFile = `${base}\nexport function readRecord(s) { return JSON.parse(s) as Rec; }`;
  assert.deepEqual(applyApprovals(scan(file, sameFile), approvals).map(f => f.function), ['readRecord']);
  // same function, different (new) parse expression
  const sameFn = 'class JsonReader { string() { const r = JSON.parse(raw) as Rec; return JSON.parse(this.text.slice(start, this.offset)) as string; } }';
  assert.deepEqual(applyApprovals(scan(file, sameFn), approvals).map(f => f.expression), ['JSON.parse(raw) as Rec']);
  // edited approved expression (target type changed) is no longer covered
  assert.equal(applyApprovals(scan(file, base.replace('as string', 'as Record')), approvals).length, 1);
  // duplicate identical site beyond `sites` (default 1)
  assert.equal(applyApprovals(scan(file, base.replace('return', 'JSON.parse(this.text.slice(start, this.offset)) as string; return')), approvals).length, 1);
  // other file with identical text
  assert.equal(applyApprovals(scan('host/plugins/p/src/other.ts', base), approvals).length, 1);
});
test('live approvals file: five C1 exceptions remain; removed C2 records.ts assertion is reported if reintroduced', async () => {
  const fs = await import('node:fs');
  const approvals = loadApprovals(fs.readFileSync(new URL('./approved-decoders.json', import.meta.url), 'utf8'));
  assert.equal(approvals.length, 5);
  assert.ok(approvals.every(a => a.approvedBy === 'C1-app'));
  const file = 'host/plugins/sync-support/repository/records.ts';
  // The old assertion must not silently regain its retired approval.
  const real = 'export function parseLlmUsageDailyRecordId(recordId: string) {\n  const value = JSON.parse(recordId) as Record<string, unknown> | null;\n  return value;\n}\n';
  assert.deepEqual(applyApprovals(scan(file, real), approvals).map(f => [f.function, f.rule, f.expression]),
    [['parseLlmUsageDailyRecordId', 'json-parse-assertion', 'JSON.parse(recordId) as Record<string, unknown> | null']]);
  assert.deepEqual(applyApprovals(scan(file, real.replace('const value = JSON.parse(recordId) as Record<string, unknown> | null', 'const value: unknown = JSON.parse(recordId)')), approvals), []);
  const sameFn = real.replace('JSON.parse(recordId) as Record<string, unknown> | null', 'JSON.parse(recordId) as Record<string, unknown> | null; const extra = JSON.parse(recordId) as LlmUsageRow');
  assert.deepEqual(applyApprovals(scan(file, sameFn), approvals).map(f => [f.function, f.rule]), [['parseLlmUsageDailyRecordId', 'json-parse-assertion'], ['parseLlmUsageDailyRecordId', 'json-parse-assertion']]);
  const sameFile = `${real}\nexport function decodeOther(s: string) { return JSON.parse(s) as Record<string, unknown> | null; }`;
  assert.deepEqual(applyApprovals(scan(file, sameFile), approvals).map(f => f.function), ['parseLlmUsageDailyRecordId', 'decodeOther']);
  // rowToAutomation (automation-definitions.ts:92) stays unapproved
  assert.ok(!approvals.some(a => a.function === 'rowToAutomation'));
});
test('file-level, function-only or glob approvals are rejected', () => {
  assert.throws(() => loadApprovals(JSON.stringify({ approvals: [{ path: 'a.ts', rule: 'json-parse-assertion', expression: 'e', approvedBy: 'x', evidence: 'y' }] })));
  assert.throws(() => loadApprovals(JSON.stringify({ approvals: [{ path: 'a.ts', function: 'f', rule: 'r', approvedBy: 'x', evidence: 'y' }] })));
  assert.throws(() => loadApprovals(JSON.stringify({ approvals: [{ path: 'host/*.ts', function: 'f', rule: 'r', expression: 'e', approvedBy: 'x', evidence: 'y' }] })));
});
