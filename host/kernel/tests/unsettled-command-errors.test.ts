/**
 * W01：命令错误动态守卫的工具（testing.ts `minimalCommandArgs` / `commandErrorOutcome` / `unsettledCommandErrors`，
 * API.md §2.3.1）与守卫登记的静态检查（eslint-rules/no-untyped-command-throw.baseline.mjs `settleGuardProblem`）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { settleGuardProblem } from '../../../eslint-rules/no-untyped-command-throw.baseline.mjs';
import { definePlugin, type HostPlugin } from '../api.ts';
import type { CommandArg, CommandContract, JsonSchema, LaneContract } from '../contract.ts';
import { ContractSet } from '../contracts.ts';
import { AppError, CommandError } from '../error-model.ts';
import { commandErrorOutcome, createTestHost, minimalCommandArgs, unsettledCommandErrors, type TestHost } from '../testing.ts';

const arg = (key: string, schema: JsonSchema, optional = false): CommandArg => ({ key, rustName: key, schema, optional });

function command(name: string, args: CommandArg[] = [arg('id', { type: 'string' })]): CommandContract {
  return {
    name,
    lane: 'W01-guard',
    rust: { file: 'src/w01_guard.rs', line: 1, fn: name },
    async: true,
    args,
    injected: [],
    result: { type: 'null' },
    error: { $ref: '_shared.json#/$defs/AppError' },
    frontend: 'app',
  };
}

const LANE: LaneContract = {
  lane: 'W01-guard',
  generator: 'hand-written W01 fixture',
  commands: [
    command('w01_guard_ok'),
    command('w01_guard_classified'),
    command('w01_guard_bare'),
    command('w01_guard_shape'),
    command('w01_guard_slow'),
    command('w01_guard_needs_args'),
    command('w01_guard_minimal', [
      arg('id', { type: 'string' }),
      arg('limit', { type: 'integer', minimum: 5 }),
      arg('count', { type: ['integer', 'null'] }),
      arg('mode', { enum: ['fast', 'slow'] }),
      arg('tag', { const: 'v1' }),
      arg('flag', { type: 'boolean' }),
      arg('items', { type: 'array', items: { type: 'string' } }),
      arg('maybe', { oneOf: [{ type: 'null' }, { type: 'string' }] }),
      arg('req', { $ref: '#/$defs/W01GuardReq' }),
      arg('shared', { $ref: '_shared.json#/$defs/AppError' }),
      arg('opt', { type: 'string' }, true),
    ]),
  ],
  events: [],
  $defs: {
    W01GuardReq: {
      type: 'object',
      required: ['name', 'size'],
      properties: { name: { type: 'string' }, size: { type: 'number', minimum: 0 }, note: { type: 'string' } },
    },
  },
};
const contracts = () => ContractSet.fromDirectory().with([{ file: 'W01-guard.json', contract: LANE }]);
const GUARDED = LANE.commands.map((c) => c.name).filter((name) => name !== 'w01_guard_minimal');

const guardPlugin = definePlugin({
  meta: { id: 'fixture.w01-guard', commands: GUARDED },
  apply(ctx) {
    ctx.commands.register('w01_guard_ok', () => null);
    ctx.commands.register('w01_guard_classified', () => { throw AppError.not_found('记录不存在: x'); });
    ctx.commands.register('w01_guard_bare', () => { throw new Error('boom'); });
    ctx.commands.register('w01_guard_shape', () => { throw new CommandError({ nope: 1 }); });
    ctx.commands.register('w01_guard_slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return null;
    });
    ctx.commands.register<{ id: string }>('w01_guard_needs_args', ({ id }) => {
      if (id !== 'real') throw new Error(`unknown id ${id}`);
      return null;
    });
  },
});

describe('minimalCommandArgs', () => {
  it('builds the smallest values the argument schemas accept, following lane and _shared.json refs', () => {
    const set = contracts();
    const args = minimalCommandArgs(set, 'w01_guard_minimal');
    expect(args).toEqual({
      id: 'x',
      limit: 5,
      count: 1,
      mode: 'fast',
      tag: 'v1',
      flag: false,
      items: [],
      maybe: 'x',
      req: { name: 'x', size: 1 },
      shared: { error_type: 'Validation', message: 'x', details: null },
    });
    expect(set.checkArgs(set.get('w01_guard_minimal')!, args)).toMatchObject({ ok: true });
  });

  it('rejects commands outside the contracts', () => {
    expect(() => minimalCommandArgs(contracts(), 'w01_guard_nowhere')).toThrow(/not in the contracts/);
  });
});

describe('commandErrorOutcome', () => {
  it('times out a promise that does not settle', async () => {
    expect(await commandErrorOutcome(new Promise(() => {}), 20)).toBe('did not settle');
  });

  it('treats a non-diagnostic string rejection as classified', async () => {
    expect(await commandErrorOutcome(Promise.reject('文件不存在'))).toBe('classified');
  });
});

describe('unsettledCommandErrors', () => {
  let host: TestHost | undefined;
  afterEach(async () => {
    await host?.dispose();
    host = undefined;
  });

  it('reports unclassified throws, contract violations, slow commands and commands outside the contracts', async () => {
    host = await createTestHost({ contracts: contracts(), plugins: [guardPlugin] });
    const ghost = { meta: { id: 'fixture.ghost', commands: ['w01_guard_ghost'] } } as unknown as HostPlugin;
    const bad = await unsettledCommandErrors(host, [guardPlugin, ghost], { timeoutMs: 100 });
    expect(bad).toEqual([
      'fixture.w01-guard w01_guard_bare: unclassified: boom',
      expect.stringMatching(/^fixture\.w01-guard w01_guard_shape: contract: \[dstu-host\] command "w01_guard_shape" rejected with a value that violates its contract/),
      'fixture.w01-guard w01_guard_slow: did not settle',
      'fixture.w01-guard w01_guard_needs_args: unclassified: unknown id x',
      'fixture.ghost w01_guard_ghost: not in contracts',
    ]);
  });

  it('honours exclude and per-command arguments', async () => {
    host = await createTestHost({ contracts: contracts(), plugins: [guardPlugin] });
    const bad = await unsettledCommandErrors(host, [guardPlugin], {
      exclude: ['w01_guard_bare', 'w01_guard_shape', 'w01_guard_slow'],
      args: (name) => (name === 'w01_guard_needs_args' ? { id: 'real' } : undefined),
    });
    expect(bad).toEqual([]);
  });
});

describe('settleGuardProblem', () => {
  const root = mkdtempSync(join(tmpdir(), 'dstu-w01-guard-ledger-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const KERNEL = "import { unsettledCommandErrors } from '../../../kernel/testing.ts';\n";

  it('accepts a guard that imports its owner and the kernel helper', () => {
    write('host/plugins/demo/index.ts', 'export default {};\n');
    write('host/plugins/demo/tests/command-error-settle.test.ts', `${KERNEL}import demo from '../index.ts';\n`);
    expect(settleGuardProblem('host/plugins/demo', 'host/plugins/demo/tests/command-error-settle.test.ts', root)).toBeNull();
    write('host/plugins/other/tests/command-error-settle.extra.test.ts',
      "import {\n  HandlerPanic,\n} from '../../../kernel/testing.ts';\nimport demo from '../../demo/index.ts';\n");
    expect(settleGuardProblem('host/plugins/demo', 'host/plugins/other/tests/command-error-settle.extra.test.ts', root)).toBeNull();
  });

  it('rejects missing files, other names, guards that skip the owner or the kernel helper', () => {
    expect(settleGuardProblem('host/plugins/demo', 'host/plugins/demo/tests/command-error-settle.missing.test.ts', root)).toMatch(/does not exist/);
    write('host/plugins/demo/tests/errors.test.ts', `${KERNEL}import demo from '../index.ts';\n`);
    expect(settleGuardProblem('host/plugins/demo', 'host/plugins/demo/tests/errors.test.ts', root)).toMatch(/must be named/);
    write('host/plugins/demo/tests/harness.ts', 'export {};\n');
    write('host/plugins/demo/tests/command-error-settle.harness.test.ts', `${KERNEL}import './harness.ts';\n`);
    expect(settleGuardProblem('host/plugins/demo', 'host/plugins/demo/tests/command-error-settle.harness.test.ts', root)).toMatch(/does not import any module/);
    write('host/plugins/demo-two/index.ts', 'export default {};\n');
    write('host/plugins/demo-two/tests/command-error-settle.test.ts', `${KERNEL}import two from '../index.ts';\n`);
    expect(settleGuardProblem('host/plugins/demo', 'host/plugins/demo-two/tests/command-error-settle.test.ts', root)).toMatch(/does not import any module/);
    write('host/plugins/demo/tests/command-error-settle.nokernel.test.ts', "import { createTestHost } from '../../../kernel/testing.ts';\nimport demo from '../index.ts';\n");
    expect(settleGuardProblem('host/plugins/demo', 'host/plugins/demo/tests/command-error-settle.nokernel.test.ts', root)).toMatch(/does not use unsettledCommandErrors/);
  });
});
