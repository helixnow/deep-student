import { describe, expect, it } from 'vitest';
import { computeLedger, evaluateCommand, evaluateTest, type LedgerContext } from './lib/ledger-core.mjs';
import { scanPluginFile } from './lib/plugin-scan.mjs';
import { isTestFile } from './lib/boundary-rules.mjs';

function ctx(over: Partial<LedgerContext> = {}, files: Record<string, string> = {}): LedgerContext {
  return {
    approvals: { obsolete: {}, deadProven: {} },
    fileExists: (p) => p in files,
    fileText: (p) => files[p] ?? '',
    isTestFile,
    vitest: null,
    declared: new Map(),
    registered: new Map(),
    contracts: new Set(['qbank_list']),
    violationsByFile: new Map(),
    coverage: null,
    spec: () => null,
    review: () => ({ ok: false, state: 'missing' }),
    golden: null,
    ...over,
  };
}

const row = { id: 'crates/q/src/a.rs::tests::grades_answer', lane: 'L14-qbank', real: true, kind: 'test', name: 'grades_answer' };
const cmd = { name: 'qbank_list', file: 'src/commands.rs', line: 10, lane: 'L14-qbank', frontend: 'app' };

describe('test levels', () => {
  const files = { 'host/plugins/qbank/tests/grading.test.ts': "it('grades_answer', () => {});" };
  it('pending is neither A nor B', () => {
    expect(evaluateTest(row, 'pending', ctx({}, files))).toMatchObject({ A: false, B: false, problem: null });
  });
  it('ported needs an existing test file containing the Rust test name', () => {
    expect(evaluateTest(row, 'ported:host/plugins/qbank/tests/grading.test.ts', ctx({}, files))).toMatchObject({ A: true, B: false });
    expect(evaluateTest(row, 'ported:host/plugins/qbank/tests/missing.test.ts', ctx({}, files)).problem).toMatch(/不存在/);
    expect(evaluateTest(row, 'ported:host/plugins/qbank/src/grading.ts', ctx({}, { 'host/plugins/qbank/src/grading.ts': 'grades_answer' })).problem).toMatch(/不是测试文件/);
    expect(evaluateTest({ ...row, name: 'other' }, 'ported:host/plugins/qbank/tests/grading.test.ts', ctx({}, files)).problem).toMatch(/找不到/);
  });
  it('B requires the vitest report to show the matching cases passing', () => {
    const pass = new Map([['host/plugins/qbank/tests/grading.test.ts', [{ title: 'grades_answer', fullName: 'grading grades_answer', status: 'passed' }]]]);
    const fail = new Map([['host/plugins/qbank/tests/grading.test.ts', [{ title: 'grades_answer', fullName: 'grading grades_answer', status: 'failed' }]]]);
    expect(evaluateTest(row, 'ported:host/plugins/qbank/tests/grading.test.ts', ctx({ vitest: pass }, files))).toMatchObject({ A: true, B: true });
    expect(evaluateTest(row, 'ported:host/plugins/qbank/tests/grading.test.ts', ctx({ vitest: fail }, files))).toMatchObject({ A: true, B: false });
  });
  it('obsolete counts only when approved; invalid statuses are problems', () => {
    expect(evaluateTest(row, 'obsolete:依赖 Tauri 窗口', ctx({}, files))).toMatchObject({ A: false, problem: expect.stringMatching(/未.*批准/) });
    expect(evaluateTest(row, 'obsolete:x', ctx({ approvals: { obsolete: { [row.id]: 'ok' } } }, files))).toMatchObject({ A: true, B: true });
    expect(evaluateTest(row, 'done', ctx({}, files)).problem).toMatch(/无效去向/);
  });
  it('prod-reachable unreachable vetoes A for that ported row only; unknown and obsolete unaffected', () => {
    const status = 'ported:host/plugins/qbank/tests/grading.test.ts';
    const other = { ...row, id: 'crates/q/src/a.rs::tests::other_case', name: 'grades_answer' };
    const unreachable = new Set([row.id]);
    expect(evaluateTest(row, status, ctx({ unreachable }, files))).toMatchObject({ A: false, B: false, unreachable: true, problem: null });
    expect(evaluateTest(other, status, ctx({ unreachable }, files))).toMatchObject({ A: true });
    expect(evaluateTest(row, 'obsolete:x', ctx({ unreachable, approvals: { obsolete: { [row.id]: 'ok' } } }, files))).toMatchObject({ A: true, B: true });
    const led = computeLedger({ ...ctx({ unreachable }, files), commands: [], tests: [row, other], statuses: new Map([[row.id, status], [other.id, status]]) });
    expect(led.summary.lanes['L14-qbank']).toMatchObject({ tests: 2, testA: 1, testUnreachable: 1 });
    expect(led.problems.tests).toEqual([]);
  });
  it('merged with a case name requires that case in the target', () => {
    expect(evaluateTest(row, 'merged:host/plugins/qbank/tests/grading.test.ts::grades_answer', ctx({}, files)).A).toBe(true);
    expect(evaluateTest(row, 'merged:host/plugins/qbank/tests/grading.test.ts::nope', ctx({}, files)).A).toBe(false);
  });
});

describe('command levels', () => {
  const plugin = 'host/plugins/qbank/manifest.ts';
  const full = (over: Partial<LedgerContext> = {}) =>
    ctx({
      declared: new Map([['qbank_list', [{ plugin: 'dstu.qbank', file: plugin, lane: 'L14-qbank' }]]]),
      registered: new Map([['qbank_list', [{ file: plugin, kind: 'literal' as const }]]]),
      ...over,
    });
  it('A needs declaration, registration, contract, clean files and a single owner', () => {
    expect(evaluateCommand('L14-qbank', 'qbank_list', [cmd], full()).A).toBe(true);
    expect(evaluateCommand('L14-qbank', 'qbank_list', [cmd], full({ contracts: null })).A).toBe(false);
    expect(evaluateCommand('L14-qbank', 'qbank_list', [cmd], full({ violationsByFile: new Map([[plugin, 1]]) })).A).toBe(false);
    expect(evaluateCommand('L14-qbank', 'qbank_list', [cmd], full({ registered: new Map() })).problems).toContain('已声明但静态未见注册');
    const dup = full({ declared: new Map([['qbank_list', [{ plugin: 'a', file: plugin, lane: 'L14-qbank' }, { plugin: 'b', file: 'host/plugins/x/m.ts', lane: 'L14-qbank' }]]]) });
    expect(evaluateCommand('L14-qbank', 'qbank_list', [cmd], dup).A).toBe(false);
    const wrongLane = full({ declared: new Map([['qbank_list', [{ plugin: 'dstu.review', file: plugin, lane: 'L15-review-analytics' }]]]) });
    expect(evaluateCommand('L14-qbank', 'qbank_list', [cmd], wrongLane).A).toBe(false);
    const kernel = full({ coverage: { declaredNotRegistered: [{ plugin: 'dstu.qbank', command: 'qbank_list' }], unknown: [] } });
    expect(evaluateCommand('L14-qbank', 'qbank_list', [cmd], kernel).A).toBe(false);
  });
  it('B needs completed SPEC sections and a closed acceptance review; C needs golden pass', () => {
    const done = { checked: 7, total: 7 };
    const specOk = full({ spec: () => done, review: () => ({ ok: true, state: 'ok' }), golden: new Map([['qbank_list', 'pass']]) });
    expect(evaluateCommand('L14-qbank', 'qbank_list', [cmd], specOk)).toMatchObject({ A: true, B: true, C: true });
    const specOpen = full({ spec: (_l, k) => (k === 'spec:global' ? done : { checked: 6, total: 7 }), review: () => ({ ok: true, state: 'ok' }) });
    expect(evaluateCommand('L14-qbank', 'qbank_list', [cmd], specOpen)).toMatchObject({ A: true, B: false, C: false });
  });
  it('dead-proven commands count once approved', () => {
    expect(evaluateCommand('L14-qbank', 'qbank_list', [cmd], ctx({ approvals: { deadProven: { qbank_list: 'ok' } } }))).toMatchObject({ A: true, B: true, BTest: true, BDoc: true, C: true });
  });

  describe('B split: B-test (code + mapped tests pass) vs B-doc (SPEC/ACCEPTANCE checked)', () => {
    const testFile = 'host/plugins/qbank/tests/list.test.ts';
    const files: Record<string, string> = { [testFile]: "it('lists_rows', () => {}); it('other_case', () => {});" };
    const sameFile = { id: 'src/commands.rs::tests::lists_rows', lane: 'L14-qbank', real: true, kind: 'test', name: 'lists_rows' };
    const otherFile = { id: 'src/other.rs::tests::other_case', lane: 'L14-qbank', real: true, kind: 'test', name: 'other_case' };
    const report = (status: string) => new Map([[testFile, [
      { title: 'lists_rows', fullName: 'q lists_rows', status },
      { title: 'other_case', fullName: 'q other_case', status: 'failed' },
    ]]]);
    const statuses = new Map([[sameFile.id, `ported:${testFile}`], [otherFile.id, `ported:${testFile}`]]);
    const ledger = (over: Partial<LedgerContext>, tests = [sameFile, otherFile]) =>
      computeLedger({ ...full(over), commands: [cmd], tests, statuses });
    const io = { fileExists: (p: string) => p in files, fileText: (p: string) => files[p] ?? '' };
    const docsDone = { spec: () => ({ checked: 3, total: 3 }), review: () => ({ ok: true, state: 'ok' }) };

    it('B-test needs A and every test mapped from the same Rust file passing; docs are irrelevant', () => {
      const c = ledger({ ...io, vitest: report('passed') }).commands[0]!;
      expect(c).toMatchObject({ A: true, BTest: true, BDoc: false, B: false });
      expect(c.evidence).toMatchObject({ tests: '1/1 file' });
      expect(ledger({ ...io, vitest: report('failed') }).commands[0]).toMatchObject({ BTest: false });
      expect(ledger({ ...io, vitest: null }).commands[0]).toMatchObject({ BTest: false });
    });

    it('falls back to all real tests of the lane when the command file has no mapped tests', () => {
      const c = ledger({ ...io, vitest: report('passed') }, [otherFile]).commands[0]!;
      expect(c).toMatchObject({ BTest: false, evidence: expect.objectContaining({ tests: '0/1 lane' }) });
      expect(ledger({ ...io, vitest: report('passed') }, []).commands[0]).toMatchObject({ BTest: false, evidence: expect.objectContaining({ tests: null }) });
    });

    it('B-doc is the checkbox evidence alone; legacy B stays A ∧ B-doc', () => {
      const notA = computeLedger({ ...ctx({ ...docsDone }), commands: [cmd], tests: [], statuses: new Map() }).commands[0]!;
      expect(notA).toMatchObject({ A: false, BDoc: true, B: false, BTest: false });
      const both = ledger({ ...io, ...docsDone, vitest: report('passed') }).commands[0]!;
      expect(both).toMatchObject({ A: true, BTest: true, BDoc: true, B: true });
    });

    it('summaries carry B-test and B-doc counts and percentages next to legacy B', () => {
      const s = ledger({ ...io, vitest: report('passed') }).summary;
      expect(s.global).toMatchObject({ commands: 1, cmdB: 0, cmdBTest: 1, cmdBDoc: 0, pctCmdBTest: 100, pctCmdBDoc: 0 });
      expect(s.lanes['L14-qbank']).toMatchObject({ cmdBTest: 1, pctCmdBTest: 100 });
    });
  });
  it('merges cfg variants of one command and computes per-lane percentages', () => {
    const l = computeLedger({ ...full(), commands: [cmd, { ...cmd, line: 20 }, { ...cmd, name: 'qbank_other' }], tests: [row], statuses: new Map() });
    expect(l.commands.map((c) => [c.name, c.defs.length, c.A])).toEqual([['qbank_list', 2, true], ['qbank_other', 1, false]]);
    expect(l.summary.lanes['L14-qbank']).toMatchObject({ commands: 2, cmdA: 1, pctCmdA: 50, tests: 1, testA: 0 });
  });
});

describe('plugin scan', () => {
  it('reads meta.commands (literal or const) and literal registrations', () => {
    const src = [
      "import { definePlugin } from '../../kernel/api.ts';",
      "const COMMANDS = ['qbank_list', 'qbank_get'] as const;",
      'export default definePlugin({',
      "  meta: { id: 'dstu.qbank', lane: 'L14-qbank', commands: COMMANDS },",
      '  apply(ctx) {',
      "    ctx.commands.register('qbank_list', list);",
      '    for (const [name, h] of Object.entries(handlers)) ctx.commands.register(name, h);',
      '  },',
      '});',
      'const handlers = { qbank_get: get };',
    ].join('\n');
    const s = scanPluginFile('host/plugins/qbank/manifest.ts', src);
    expect(s.plugins).toEqual([{ id: 'dstu.qbank', lane: 'L14-qbank', commands: ['qbank_list', 'qbank_get'], unresolvedCommands: false, line: 3 }]);
    expect(s.registers).toEqual([{ command: 'qbank_list', line: 6 }]);
    expect(s.dynamicRegisters).toBe(1);
    expect(s.objectKeys.has('qbank_get')).toBe(true);
  });
});
