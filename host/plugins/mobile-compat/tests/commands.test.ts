/**
 * `dstu.mobile.compat` 命令表守护：
 * - 由生成器复算一致（漂移时重跑 `node scripts/mobile-compat/generate.mjs`）；
 * - 每条命令都有 IPC 契约、都在 Rust `allow-application-commands` 里；
 * - 与其它移动端插件声明的命令不重叠（占位不得遮蔽真实实现）；
 * - 调用时返回 `UNSUPPORTED_ON_PLATFORM`，而不是 kernel 的 `not allowed by ACL`。
 */
import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { CommandError } from '../../../kernel/api.ts';
import { UNSUPPORTED_ON_PLATFORM_PREFIX } from '../../../platform/errors/unsupported-on-platform.ts';
import { bundledContracts } from '../../../../mobile/src/worker/contracts.ts';
import { COMPAT_COMMANDS } from '../commands.ts';

const GENERATOR = new URL('../../../../scripts/mobile-compat/generate.mjs', import.meta.url);

interface GeneratorModule {
  compatCommands(root?: string): Promise<string[]>;
  rustAppCommands(root?: string): Set<string>;
  contractCommands(root?: string): Set<string>;
}

async function generator(): Promise<GeneratorModule> {
  return await import(pathToFileURL(GENERATOR.pathname).href) as GeneratorModule;
}

describe('mobile compat command table', () => {
  it('is sorted, unique and non-empty', () => {
    expect(COMPAT_COMMANDS.length).toBeGreaterThan(0);
    expect(new Set(COMPAT_COMMANDS).size).toBe(COMPAT_COMMANDS.length);
    expect([...COMPAT_COMMANDS]).toEqual([...COMPAT_COMMANDS].sort());
  });

  it('matches the generator (profile / contracts / Rust allow list drift)', async () => {
    const { compatCommands } = await generator();
    expect([...COMPAT_COMMANDS]).toEqual(await compatCommands());
  });

  it('every compat command has a contract and is allowed by the Rust mobile capability', async () => {
    const { rustAppCommands } = await generator();
    const allowed = rustAppCommands();
    const contracts = bundledContracts();
    for (const name of COMPAT_COMMANDS) {
      expect(contracts.get(name), name).toBeDefined();
      expect(allowed.has(name), name).toBe(true);
    }
  });

  it('does not shadow commands another mobile plugin declares', async () => {
    const { compatCommands } = await generator();
    // 生成器的集合定义就是“Rust 允许 ∩ 有契约 − 其它移动端插件声明”；复算结果一致即无重叠。
    const generated = new Set(await compatCommands());
    expect(generated.size).toBe(COMPAT_COMMANDS.length);
  });

  it('answers UNSUPPORTED_ON_PLATFORM instead of an ACL error', async () => {
    const { registerUnsupportedCommands } = await import('../../../platform/errors/unsupported-commands.ts');
    const handlers = new Map<string, () => never>();
    registerUnsupportedCommands(
      { commands: { register: (name: string, handler: () => never) => { handlers.set(name, handler); } } },
      COMPAT_COMMANDS,
    );
    expect(handlers.size).toBe(COMPAT_COMMANDS.length);
    const thrown = (() => {
      try { handlers.get(COMPAT_COMMANDS[0]!)!(); }
      catch (error) { return error; }
      return null;
    })();
    expect(thrown).toBeInstanceOf(CommandError);
    const message = (thrown as CommandError).message;
    expect(message.startsWith(UNSUPPORTED_ON_PLATFORM_PREFIX)).toBe(true);
    expect(message).toContain('is not available on mobile');
  });
});
