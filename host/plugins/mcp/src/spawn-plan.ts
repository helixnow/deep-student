// How a stdio MCP command becomes a child process on each platform.
// Rust `Command::spawn` (std ≥1.77.2, `library/std/src/sys/process/windows.rs`) runs a
// `.bat`/`.cmd` program through `<system dir>\cmd.exe` with a command line built by
// `make_bat_command_line` (`library/std/src/sys/args/windows.rs`). Node refuses to spawn
// batch files without a shell (CVE-2024-27980, EINVAL), so the same command line is built
// here and handed to cmd.exe verbatim; `shell: true` would skip the escaping.
import { win32 } from '../../../platform/util/path.ts';

export interface SpawnPlan {
  file: string;
  args: string[];
  /** Rust starts the batch command line with `cmd.exe`, not the resolved path. */
  argv0?: string;
  windowsVerbatimArguments: boolean;
}

/** Rust `io::ErrorKind::InvalidInput` raised by `Command::spawn` before any process exists. */
export class SpawnInputError extends Error {
  override name = 'SpawnInputError';
}

type EnvLike = Readonly<Record<string, string | undefined>>;

function envLookup(env: EnvLike, key: string): string | undefined {
  const wanted = key.toLowerCase();
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === wanted && value !== undefined && value !== '') return value;
  }
  return undefined;
}

/** `GetSystemDirectoryW()` + `\<exe>`; Node has no binding, so derive it from SystemRoot. */
export function windowsSystemExecutable(name: string, env: EnvLike): string {
  const root = envLookup(env, 'SystemRoot') ?? envLookup(env, 'windir');
  if (root !== undefined) return win32.join(root, 'System32', name);
  if (name.toLowerCase() === 'cmd.exe') return envLookup(env, 'ComSpec') ?? name;
  return name;
}

export function isWindowsBatchFile(command: string): boolean {
  const ext = win32.extname(command).toLowerCase();
  return ext === '.bat' || ext === '.cmd';
}

function ensureNoNul(value: string): void {
  if (value.includes('\0')) throw new SpawnInputError('nul byte found in provided data');
}

const BAT_UNQUOTED = '#$*+-./:?@\\_';

function isAsciiAlphanumeric(ch: string): boolean {
  return /^[0-9A-Za-z]$/u.test(ch);
}

/** Rust `char::is_control`: general category Cc. */
function isControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/** Rust `append_bat_arg(cmd, arg, quote = false)`. */
export function quoteBatArgument(arg: string): string {
  ensureNoNul(arg);
  let quote = arg === '' || arg.endsWith('\\');
  for (const ch of arg) {
    const codePoint = ch.codePointAt(0)!;
    const asciiNeedsQuotes = codePoint < 0x80 && !(isAsciiAlphanumeric(ch) || BAT_UNQUOTED.includes(ch));
    if (asciiNeedsQuotes || isControl(codePoint)) quote = true;
  }
  let out = quote ? '"' : '';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
    } else {
      if (ch === '"') {
        out += '\\'.repeat(backslashes);
        out += '"';
      } else if (ch === '%' || ch === '\r') {
        // `%%cd:~,%` expands to nothing and keeps cmd.exe from expanding `%VAR%`.
        out += '%%cd:~,';
      }
      backslashes = 0;
    }
    out += ch;
  }
  if (quote) out += `${'\\'.repeat(backslashes)}"`;
  return out;
}

/** Rust `make_bat_command_line(script, args, force_quotes = false)`, minus the `cmd.exe … /c ` head. */
export function batchCommandLine(script: string, args: readonly string[]): string {
  ensureNoNul(script);
  if (script.includes('"') || script.endsWith('\\')) {
    throw new SpawnInputError('Windows file names may not contain `"` or end with `\\`');
  }
  // RUST-FIX(RF-W21-bat-script-metachar): std 1.98.1 accepts `^`/`%` here and cmd.exe expands `%VAR%` in the script path; std master refuses them.
  if (/[\^%]/u.test(script)) {
    throw new SpawnInputError('`Command` rejects batch scripts that contain contain `"`, `^` or `%` or end with `\\`');
  }
  let line = `"${script}"`;
  for (const arg of args) {
    if (arg.includes('\r') || arg.includes('\n')) throw new SpawnInputError('batch file arguments are invalid');
    line += ` ${quoteBatArgument(arg)}`;
  }
  return line;
}

export interface KillTreePlan {
  file: string;
  args: string[];
}

/** `taskkill /PID <pid> /T /F` ends the server a `.cmd` wrapper (or `npx.cmd` → node) started. */
// RUST-FIX(RF-W21-windows-stdio-kill-tree): Rust ends only the direct child (cmd.exe), so the real server survives.
export function buildKillTreePlan(platform: string, pid: number | undefined, env: EnvLike): KillTreePlan | null {
  if (platform !== 'win32' || pid === undefined) return null;
  return { file: windowsSystemExecutable('taskkill.exe', env), args: ['/PID', String(pid), '/T', '/F'] };
}

/** `platform` takes `process.platform` values. */
export function buildSpawnPlan(
  platform: string, command: string, args: readonly string[], env: EnvLike,
): SpawnPlan {
  if (platform !== 'win32' || !isWindowsBatchFile(command)) {
    return { file: command, args: [...args], windowsVerbatimArguments: false };
  }
  return {
    file: windowsSystemExecutable('cmd.exe', env),
    args: ['/e:ON', '/v:OFF', '/d', '/c', `"${batchCommandLine(command, args)}"`],
    argv0: 'cmd.exe',
    windowsVerbatimArguments: true,
  };
}
