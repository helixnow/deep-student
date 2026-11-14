import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SpawnInputError, batchCommandLine, buildSpawnPlan, quoteBatArgument, windowsSystemExecutable,
} from '../src/spawn-plan.ts';

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

const { createStdioTransport } = await import('../src/stdio-proxy.ts');

afterEach(() => { spawnCalls.length = 0; });

const WINDOWS_ENV = { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs' };
const SCRIPT = 'C:\\Users\\a\\.playwright-mcp\\start-mcp.cmd';

describe('V10-P1-1 buildSpawnPlan (Rust std make_bat_command_line, args/windows.rs)', () => {
  it('win32 + .cmd runs <SystemRoot>\\System32\\cmd.exe /e:ON /v:OFF /d /c with a verbatim command line', () => {
    expect(buildSpawnPlan('win32', SCRIPT, ['--port', '1'], WINDOWS_ENV)).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/e:ON', '/v:OFF', '/d', '/c', '""C:\\Users\\a\\.playwright-mcp\\start-mcp.cmd" --port 1"'],
      argv0: 'cmd.exe',
      windowsVerbatimArguments: true,
    });
  });

  it('win32 + .BAT (any case) and a path with spaces go through cmd.exe as well', () => {
    const plan = buildSpawnPlan('win32', 'C:\\Program Files\\tools\\Start.BAT', ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\me'], WINDOWS_ENV);
    expect(plan.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.args.at(-1)).toBe('""C:\\Program Files\\tools\\Start.BAT" -y @modelcontextprotocol/server-filesystem C:\\Users\\me"');
  });

  it('win32 + .exe, extensionless and posix commands spawn directly without verbatim arguments', () => {
    const direct = (platform: NodeJS.Platform, command: string) => buildSpawnPlan(platform, command, ['a b', '"q"'], WINDOWS_ENV);
    expect(direct('win32', 'C:\\Program Files\\nodejs\\node.exe')).toEqual({
      file: 'C:\\Program Files\\nodejs\\node.exe', args: ['a b', '"q"'], windowsVerbatimArguments: false,
    });
    expect(direct('win32', 'C:\\tools\\server')).toEqual({ file: 'C:\\tools\\server', args: ['a b', '"q"'], windowsVerbatimArguments: false });
    expect(direct('linux', '/usr/local/bin/start-mcp.cmd')).toEqual({
      file: '/usr/local/bin/start-mcp.cmd', args: ['a b', '"q"'], windowsVerbatimArguments: false,
    });
    expect(direct('darwin', '/usr/local/bin/npx')).toEqual({ file: '/usr/local/bin/npx', args: ['a b', '"q"'], windowsVerbatimArguments: false });
  });

  it('cmd.exe comes from the system directory like Rust command_prompt(); ComSpec is only a last resort', () => {
    expect(windowsSystemExecutable('cmd.exe', { SYSTEMROOT: 'D:\\Win', ComSpec: 'C:\\evil\\cmd.exe' })).toBe('D:\\Win\\System32\\cmd.exe');
    expect(windowsSystemExecutable('cmd.exe', { windir: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(windowsSystemExecutable('cmd.exe', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' })).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(windowsSystemExecutable('cmd.exe', {})).toBe('cmd.exe');
  });

  // Inputs are the ones library/std tests/ui/std/windows-bat-args.rs round-trips through a .bat;
  // the expected text is derived by hand from append_bat_arg (quote unless alnum or #$*+-./:?@\_,
  // double `"`, 2n backslashes before a quote, `%` → `%%cd:~,%`).
  const cases: [string, string][] = [
    ['a', 'a'],
    ['c is for cat', '"c is for cat"'],
    ['"', '""""'],
    [' "', '" """'],
    ['\\', '"\\\\"'],
    ['>file.txt', '">file.txt"'],
    ['whoami.exe', 'whoami.exe'],
    ['&a.exe', '"&a.exe"'],
    ['&echo hello ', '"&echo hello "'],
    ['!TMP!', '"!TMP!"'],
    ['key=value', '"key=value"'],
    ['"key=value"', '"""key=value"""'],
    ['', '""'],
    ['key\\=value', '"key\\=value"'],
    ['%hello', '"%%cd:~,%hello"'],
    ['%PATH%', '"%%cd:~,%PATH%%cd:~,%"'],
    ['%%cd:~,%', '"%%cd:~,%%%cd:~,%cd:~,%%cd:~,%"'],
    ['abc"&echo hello', '"abc""&echo hello"'],
    ['hello^"world', '"hello^""world"'],
    ['hello &echo oh no >file.txt', '"hello &echo oh no >file.txt"'],
    ['C:\\dir\\', '"C:\\dir\\\\"'],
    ['a\\"b', '"a\\\\""b"'],
    ['a\\\\b', 'a\\\\b'],
    ['(x)|<y>', '"(x)|<y>"'],
    ["it's", '"it\'s"'],
    ['-y', '-y'],
    ['@scope/pkg-name@1.2.3', '@scope/pkg-name@1.2.3'],
    ['C:\\Users\\me', 'C:\\Users\\me'],
    ['中文', '中文'],
    ['a\tb', '"a\tb"'],
    ['\u0085x', '"\u0085x"'],
  ];
  it.each(cases)('quotes %j as %j', (arg, expected) => {
    expect(quoteBatArgument(arg)).toBe(expected);
  });

  it('rejects arguments with CR or LF and scripts containing " or ending with \\ like Rust 1.98.1 (InvalidInput)', () => {
    expect(() => batchCommandLine(SCRIPT, ['ok', 'line\nbreak'])).toThrow(new SpawnInputError('batch file arguments are invalid'));
    expect(() => batchCommandLine(SCRIPT, ['carriage\rreturn'])).toThrow(new SpawnInputError('batch file arguments are invalid'));
    expect(() => buildSpawnPlan('win32', SCRIPT, ['\n'], WINDOWS_ENV)).toThrow(SpawnInputError);
    for (const script of ['C:\\a"b.cmd', 'C:\\dir\\']) {
      expect(() => batchCommandLine(script, [])).toThrow(new SpawnInputError('Windows file names may not contain `"` or end with `\\`'));
    }
    expect(() => quoteBatArgument('nul\0byte')).toThrow('nul byte found in provided data');
    expect(buildSpawnPlan('linux', '/bin/start.cmd', ['line\nbreak'], {}).args).toEqual(['line\nbreak']);
  });

  it('RF-W21-bat-script-metachar: scripts containing ^ or % are refused with the std master text', () => {
    // std 1.98.1 accepts these paths; cmd.exe then expands `%X%` in `"C:\a%X%b\run.cmd"`, so the script path becomes an injection point.
    for (const script of ['C:\\100%.cmd', 'C:\\x^y.bat', 'C:\\a%X%b\\run.cmd']) {
      expect(() => batchCommandLine(script, [])).toThrow(new SpawnInputError('`Command` rejects batch scripts that contain contain `"`, `^` or `%` or end with `\\`'));
    }
  });
});

describe('V10-P1-1 createStdioTransport on win32', () => {
  it('spawns a .cmd command through cmd.exe with windowsVerbatimArguments instead of the batch file itself', async () => {
    await expect(createStdioTransport(SCRIPT, ['--port', '1'], 'jsonl', {}, null, {
      platform: 'win32', parentEnv: WINDOWS_ENV,
    })).rejects.toThrow('spawn recorded');
    expect(spawnCalls).toHaveLength(1);
    const [file, args, options] = spawnCalls[0] as [string, string[], Record<string, unknown>];
    expect({ file, args }).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/e:ON', '/v:OFF', '/d', '/c', '""C:\\Users\\a\\.playwright-mcp\\start-mcp.cmd" --port 1"'],
    });
    expect(options).toMatchObject({ argv0: 'cmd.exe', windowsVerbatimArguments: true, windowsHide: true });
    expect(options.shell).toBeUndefined();
  });

  it('reports an argument cmd.exe cannot carry as a Rust InvalidInput spawn failure without spawning', async () => {
    await expect(createStdioTransport(SCRIPT, ['line\nbreak'], 'jsonl', {}, null, {
      platform: 'win32', parentEnv: WINDOWS_ENV,
    })).rejects.toThrow(`Failed to spawn process "${SCRIPT}": batch file arguments are invalid (kind=InvalidInput, os_error=none)`);
    expect(spawnCalls).toHaveLength(0);
  });
});
