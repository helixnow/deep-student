import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnCalls: unknown[][] = [];
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      spawnCalls.push(args);
      throw new Error('spawn recorded');
    },
  };
});

const proxy = await import('../src/stdio-proxy.ts');

afterEach(() => { spawnCalls.length = 0; });

/** Windows `process.env`: lookups ignore case, enumeration shows the stored spelling. */
function windowsProcessEnv(values: Record<string, string>): Record<string, string | undefined> {
  const find = (key: string): string | undefined => Object.keys(values).find(name => name.toUpperCase() === key.toUpperCase());
  return new Proxy(values, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined;
      const name = find(key);
      return name === undefined ? undefined : target[name];
    },
    has: (_target, key) => typeof key === 'string' && find(key) !== undefined,
  });
}

/** Node `child_process` on win32 sorts env keys and keeps the first of each case-insensitive group. */
function nodeWindowsEnvBlock(env: Record<string, string>): Record<string, string> {
  const seen = new Set<string>();
  const block: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    const folded = key.toUpperCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    block[key] = env[key]!;
  }
  return block;
}

const WINDOWS_PARENT = windowsProcessEnv({
  Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  SystemRoot: 'C:\\Windows',
  PARENT_ONLY_TOKEN: 'not-for-children',
});
const USER_PATH = 'C:\\tools\\bin;C:\\Windows\\System32';

describe('V10-P2-3 mergeChildEnv (global.rs:493-504 env_clear + cmd.env, Windows EnvKey ignores case)', () => {
  it('win32: a user "Path" replaces the inherited PATH; one key per name, spelled as first inserted', () => {
    expect(proxy.mergeChildEnv('win32', WINDOWS_PARENT, { Path: USER_PATH })).toEqual({
      PATH: USER_PATH,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      SystemRoot: 'C:\\Windows',
    });
  });

  it('win32: a user key differing only in case from an inherited one keeps the inherited spelling and takes the user value', () => {
    expect(proxy.mergeChildEnv('win32', WINDOWS_PARENT, { systemroot: 'D:\\Win', MCP_MODE: 'local' })).toEqual({
      PATH: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      SystemRoot: 'D:\\Win',
      MCP_MODE: 'local',
    });
  });

  it('linux: names stay case-sensitive, so "Path" is a separate variable from PATH', () => {
    expect(proxy.mergeChildEnv('linux', { PATH: '/usr/bin', HOME: '/home/a', PARENT_ONLY_TOKEN: 'x' }, { Path: '/opt/bin' })).toEqual({
      PATH: '/usr/bin', HOME: '/home/a', Path: '/opt/bin',
    });
  });

  it('createStdioTransport on win32: the environment block Node builds carries the user Path, not the inherited PATH', async () => {
    await expect(proxy.createStdioTransport('C:\\Program Files\\nodejs\\node.exe', ['server.js'], 'jsonl', { Path: USER_PATH }, null, {
      platform: 'win32', parentEnv: WINDOWS_PARENT,
    })).rejects.toThrow('spawn recorded');
    expect(spawnCalls).toHaveLength(1);
    const options = spawnCalls[0]![2] as { env: Record<string, string> };
    expect(Object.keys(options.env).filter(key => key.toUpperCase() === 'PATH')).toEqual(['PATH']);
    expect(nodeWindowsEnvBlock(options.env)).toEqual({
      PATH: USER_PATH,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      SystemRoot: 'C:\\Windows',
    });
  });
});
