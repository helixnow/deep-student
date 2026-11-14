/**
 * 命令错误分类棘轮：`ds-host/no-untyped-command-throw`（eslint-rules/no-untyped-command-throw.js）。
 *
 * 处理函数里原样冒到 kernel 的 `throw new Error(...)` 只会变成统一内部错误（API.md §2.3），
 * Rust 的错误分类在前端就丢了。现存违规按文件冻结在 baseline.json，这里拦住任何新增。
 */
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import rule from '../../../eslint-rules/no-untyped-command-throw.js';
import {
  commandErrorInventory, lintCommandThrows, readBaseline, readSettleGuards, settleGuardProblem, unguardedOwners,
} from '../../../eslint-rules/no-untyped-command-throw.baseline.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
});

const untyped = (count = 1) => Array.from({ length: count }, () => ({ messageId: 'untyped' as const }));

describe('ds-host/no-untyped-command-throw', () => {
  tester.run('no-untyped-command-throw', rule, {
    valid: [
      `ctx.commands.register('a', () => { throw new CommandError({ type: 'NotFound' }); });`,
      `ctx.commands.register('a', () => { throw AppError.validation('bad'); });`,
      `ctx.commands.register('a', () => { throw new TypeError('kernel keeps its own fallback for these'); });`,
      // 带 catch 的 try 块内的 throw 会被同一处理函数分类
      `ctx.commands.register('a', async () => {
         try { throw new Error('x'); } catch (error) { throw new CommandError(String(error)); }
       });`,
      // 同文件内带 try/catch 的包装会把错误分类
      `function guard(fn) { try { return fn(); } catch (e) { throw new CommandError(String(e)); } }
       ctx.commands.register('a', () => guard(() => { throw new Error('x'); }));
       ctx.commands.register('b', guard(() => { throw new Error('x'); }));`,
      // 跨文件包装不追踪
      `import { commandResult } from './result';
       ctx.commands.register('a', () => commandResult(() => { throw new Error('x'); }));`,
      // 不是命令处理函数
      `function service() { throw new Error('service-level, out of scope'); }
       ctx.commands.register('a', () => service());
       ctx.events.register('a', () => { throw new Error('not a command'); });`,
      // 处理函数自己不 throw，只是调用里有一个不会被执行到 kernel 的独立回调
      `ctx.commands.register('a', () => { setTimeout(() => { throw new Error('detached'); }); return null; });`,
    ],
    invalid: [
      { code: `ctx.commands.register('a', () => { throw new Error('x'); });`, errors: untyped() },
      { code: `ctx.commands.register<{ id: string }>('a', ({ id }) => { if (!id) throw Error('x'); return id; });`, errors: untyped() },
      { code: 'app.commands.register(\'a\', async () => { throw `bad ${1}`; });', errors: untyped() },
      { code: `ctx.commands.register('a', function () { throw 'bad'; });`, errors: untyped() },
      // 同文件处理函数引用
      { code: `const handler = () => { throw new Error('x'); };\nctx.commands.register('a', handler);`, errors: untyped() },
      { code: `ctx.commands.register('a', handler);\nfunction handler() { throw new Error('x'); }`, errors: untyped() },
      // catch / finally 里的 throw 会冒出去
      {
        code: `ctx.commands.register('a', () => { try { work(); } catch (e) { throw new Error('wrapped: ' + e); } });`,
        errors: untyped(),
      },
      // 数组 / Promise 回调里的 throw 会冒出去
      { code: `ctx.commands.register('a', ({ ids }) => ids.map(id => { if (!id) throw new Error('x'); return id; }));`, errors: untyped() },
      { code: `ctx.commands.register('a', () => load().then(v => { if (!v) throw new Error('x'); return v; }));`, errors: untyped() },
      // 同文件内没有 try/catch 的透传包装
      {
        code: `const serial = (fn) => queue.then(fn);\nctx.commands.register('a', () => serial(() => { throw new Error('x'); }));`,
        errors: untyped(),
      },
      // baseline: false 报告全部（统计模式）
      { code: `ctx.commands.register('a', () => { throw new Error('x'); throw new Error('y'); });`, options: [{ baseline: false }], errors: untyped(2) },
    ],
  });
});

describe('command error ratchet', () => {
  it('host and electron command handlers do not add untyped throws beyond the baseline', async () => {
    const baseline = readBaseline();
    const { files: over, fatal } = await lintCommandThrows();
    expect(fatal, 'files the rule could not parse').toEqual([]);
    const report = Object.entries(over).map(([file, lines]) => `${file}: ${lines.length} (baseline ${baseline[file] ?? 0}) at lines ${lines.join(', ')}`);
    expect(report, 'throw CommandError / AppError instead (host/kernel/API.md §2.3)').toEqual([]);
  }, 120_000);

  it('the baseline only lists files that still have violations at exactly their recorded count or less', async () => {
    const baseline = readBaseline();
    if (Object.keys(baseline).length === 0) return;
    const { files } = await lintCommandThrows({ baseline: false, patterns: Object.keys(baseline) });
    const stale = Object.entries(baseline)
      .filter(([file, count]) => (files[file]?.length ?? 0) < count)
      .map(([file, count]) => `${file}: baseline ${count}, now ${files[file]?.length ?? 0}`);
    expect(stale, 'tighten with: node eslint-rules/no-untyped-command-throw.baseline.mjs --update').toEqual([]);
  }, 120_000);
});

/**
 * 静态的 bare 计数会把内部已分类的跨文件服务也算进来，不能当棘轮；动态守卫（API.md §2.3.1）才是：
 * 有 bare 处理函数的归属要么登记了守卫，要么在只减不增的 `unguarded` 名单里。
 */
describe('command error dynamic guards (eslint-rules/command-error-settle.json)', () => {
  it('every registered guard is a command-error-settle test of its owner', () => {
    const { guards } = readSettleGuards();
    expect(Object.keys(guards).length).toBeGreaterThan(0);
    const problems = Object.entries(guards).map(([owner, file]) => settleGuardProblem(owner, file)).filter((problem) => problem !== null);
    expect(problems).toEqual([]);
  });

  it('owners with bare command handlers have a dynamic guard or stay on the shrinking unguarded list', async () => {
    const { guards, unguarded } = readSettleGuards();
    const now = unguardedOwners(await commandErrorInventory(), guards);
    expect(now.filter((owner) => !unguarded.includes(owner)),
      'add a command-error-settle*.test.ts guard (unsettledCommandErrors from host/kernel/testing.ts) and register it in eslint-rules/command-error-settle.json').toEqual([]);
    expect(unguarded.filter((owner) => !now.includes(owner)), 'tighten with: node eslint-rules/no-untyped-command-throw.baseline.mjs --update').toEqual([]);
  }, 120_000);
});
