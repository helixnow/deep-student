/** Shell 词法解析与命令分析：移植 approval_scope.rs 的 shell analysis 分支。 */
import { isRustWhitespace, rustTrim } from '../../../../platform/util/index.ts';
import { asciiLower } from '../runtime-path-values.ts';
import { rawHash, rustSplitWhitespace, sortedStrings, type ShellCommandAnalysis } from './core.ts';
export { commandPrefix, policyCommandView };
export type { PolicyCommandView };

const DANGEROUS_SHELL_OPERATORS = [
  '&&', '||', ';', '|', '$(', '`', '>>', '>', '<<', '<', '&', '\n', '\r',
  '；', '｜', '＆',
];

const ARBITRARY_CODE_RUNNERS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'ash', 'dash', 'ksh', 'csh', 'tcsh', 'python', 'python3',
  'python2', 'ruby', 'perl', 'lua', 'node', 'deno', 'bun', 'java', 'dotnet', 'php', 'cargo',
  'make', 'cmake', 'ninja', 'eval', 'exec', 'source',
  'powershell', 'pwsh', 'cmd', 'command', 'iex', 'invoke-expression', 'invoke-command',
  'wscript', 'cscript', 'mshta',
]);

const COMMAND_WRAPPERS = new Set([
  'env', 'nice', 'nohup', 'timeout', 'gtimeout', 'command', 'sudo', 'doas', 'xargs', 'setsid',
  'stdbuf', 'ionice', 'chrt',
]);

interface PolicyCommandView {
  words: string[];
  effectiveIndex: number;
  executable: string;
  wrappers: string[];
  packageRunner: boolean;
  arbitraryPayload: boolean;
}

function flushLexWord(current: string, words: string[]): string {
  if (current !== '') {
    words.push(current);
    return '';
  }
  return current;
}

/** Quote-aware lexer used only for conservative policy classification. */
export function lexShellCommandSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let current = '';
  let quote: string | null = null;
  const chars = Array.from(command);
  let index = 0;

  while (index < chars.length) {
    const ch = chars[index]!;
    index++;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"') {
        const next = chars[index];
        if (next !== undefined && ['"', '\\', '$', '`'].includes(next)) {
          current += next;
          index++;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '\'' || ch === '"') {
      quote = ch;
    } else if (ch === '\\') {
      const next = chars[index];
      if (next !== undefined && (isRustWhitespace(next.codePointAt(0) ?? 0) || ['\'', '"', '\\', ';', '|', '&', '<', '>'].includes(next))) {
        current += next;
        index++;
      } else {
        current += ch;
      }
    } else if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r'
      || ch === '；' || ch === '｜' || ch === '＆') {
      current = flushLexWord(current, words);
      if (words.length > 0) { segments.push(words); words = []; }
    } else if (ch === '<' || ch === '>') {
      current = flushLexWord(current, words);
      words.push(ch);
    } else if (isRustWhitespace(ch.codePointAt(0) ?? 0)) {
      current = flushLexWord(current, words);
    } else {
      current += ch;
    }
  }
  current = flushLexWord(current, words);
  if (words.length > 0) segments.push(words);
  return segments;
}

function executableBasenameLower(token: string): string {
  const parts = token.split(/[\\/]/);
  const basename = asciiLower(parts[parts.length - 1] ?? token);
  for (const suffix of ['.exe', '.cmd', '.bat']) {
    if (basename.endsWith(suffix)) return basename.slice(0, -suffix.length);
  }
  return basename;
}

function isEnvAssignment(token: string): boolean {
  const equals = token.indexOf('=');
  if (equals < 0) return false;
  const key = token.slice(0, equals);
  if (key === '') return false;
  if (!/^[A-Za-z0-9_]+$/.test(key)) return false;
  const first = key[0]!;
  return first === '_' || /^[A-Za-z]$/.test(first);
}

function policyCommandView(words: string[]): PolicyCommandView | null {
  let index = 0;
  const wrappers: string[] = [];
  let packageRunner = false;
  let arbitraryPayload = false;

  while (index < words.length) {
    const launcher = executableBasenameLower(words[index]!);

    if (launcher === 'npx') {
      wrappers.push(launcher);
      packageRunner = true;
      index += 1;
      while (index < words.length && words[index]!.startsWith('-')) {
        const word = words[index]!;
        const takesValue = ['-p', '--package', '-c', '--call', '--cache', '--userconfig'].includes(word)
          && !word.includes('=');
        index += 1 + (takesValue && index + 1 < words.length ? 1 : 0);
      }
      break;
    }
    if (launcher === 'npm'
      && (words[index + 1] === 'exec' || words[index + 1] === 'x')) {
      wrappers.push('npm-exec');
      packageRunner = true;
      index += 2;
      while (index < words.length && words[index]!.startsWith('-')) {
        const word = words[index]!;
        const takesValue = ['--package', '--workspace', '--prefix', '--userconfig'].includes(word)
          && !word.includes('=');
        index += 1 + (takesValue && index + 1 < words.length ? 1 : 0);
      }
      if (words[index] === '--') index += 1;
      break;
    }
    if (!COMMAND_WRAPPERS.has(launcher)) break;

    wrappers.push(launcher);
    index += 1;
    if (launcher === 'env') {
      while (index < words.length) {
        const token = words[index]!;
        if (token === '--') { index += 1; break; }
        const takesValue = ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(token)
          && !token.includes('=');
        if (token === '-S' || token === '--split-string' || token.startsWith('--split-string=')) {
          arbitraryPayload = true;
        }
        if (token.startsWith('-')) {
          index += 1 + (takesValue && index + 1 < words.length ? 1 : 0);
        } else if (isEnvAssignment(token)) {
          index += 1;
        } else {
          break;
        }
      }
    } else if (launcher === 'nice') {
      while (index < words.length && words[index]!.startsWith('-')) {
        const word = words[index]!;
        const takesValue = ['-n', '--adjustment'].includes(word) && !word.includes('=');
        index += 1 + (takesValue && index + 1 < words.length ? 1 : 0);
      }
    } else if (launcher === 'timeout' || launcher === 'gtimeout') {
      while (index < words.length && words[index]!.startsWith('-')) {
        const word = words[index]!;
        const takesValue = ['-k', '--kill-after', '-s', '--signal'].includes(word) && !word.includes('=');
        index += 1 + (takesValue && index + 1 < words.length ? 1 : 0);
      }
      if (index < words.length) index += 1; // duration
    } else if (launcher === 'sudo' || launcher === 'doas') {
      while (index < words.length && words[index]!.startsWith('-')) {
        const word = words[index]!;
        const takesValue = [
          '-C', '-D', '-g', '-h', '-p', '-R', '-T', '-u', '--chdir', '--group', '--host',
          '--prompt', '--role', '--type', '--user',
        ].includes(word) && !word.includes('=');
        index += 1 + (takesValue && index + 1 < words.length ? 1 : 0);
      }
    } else if (launcher === 'xargs') {
      while (index < words.length && words[index]!.startsWith('-')) {
        const word = words[index]!;
        const takesValue = [
          '-a', '--arg-file', '-d', '--delimiter', '-E', '--eof', '-I', '--replace', '-L',
          '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars',
        ].includes(word) && !word.includes('=');
        index += 1 + (takesValue && index + 1 < words.length ? 1 : 0);
      }
    } else if (launcher === 'stdbuf' || launcher === 'ionice' || launcher === 'chrt') {
      while (index < words.length && words[index]!.startsWith('-')) {
        const word = words[index]!;
        const takesValue = [
          '-i', '-o', '-e', '-c', '--class', '-n', '--classdata', '-p', '--pid', '-r', '--priority',
        ].includes(word) && !word.includes('=');
        index += 1 + (takesValue && index + 1 < words.length ? 1 : 0);
      }
    } else {
      while (index < words.length && words[index]!.startsWith('-')) index += 1;
    }
  }

  const word = words[index];
  const executable = word !== undefined ? executableBasenameLower(word) : wrappers.at(-1);
  if (executable === undefined) return null;
  return { words, effectiveIndex: index, executable, wrappers, packageRunner, arbitraryPayload };
}

function isScriptRunnerToken(token: string): boolean {
  const parts = token.split(/[\\/]/);
  const basenameLower = asciiLower(parts[parts.length - 1] ?? token);
  if (['.bat', '.cmd', '.ps1', '.vbs', '.jse', '.wsf', '.sh', '.py', '.js', '.mjs', '.cjs', '.rb', '.pl', '.lua']
    .some(extension => basenameLower.endsWith(extension))) {
    return true;
  }
  const normalized = basenameLower.endsWith('.exe') ? basenameLower.slice(0, -4) : basenameLower;
  return ARBITRARY_CODE_RUNNERS.has(normalized);
}

function isPathExecutableToken(token: string): boolean {
  return token.includes('/') || token.includes('\\') || token.startsWith('.') || token.startsWith('~');
}

function commandViewIsNetworkCapable(view: PolicyCommandView): boolean {
  if (view.packageRunner
    || view.arbitraryPayload
    || isScriptRunnerToken(view.executable)
    || isPathExecutableToken(view.words[view.effectiveIndex] ?? view.executable)) {
    return true;
  }
  const second = asciiLower(view.words[view.effectiveIndex + 1] ?? '');
  if ([
    'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet', 'ftp', 'ping',
    'tracert', 'traceroute', 'nslookup', 'dig', 'invoke-webrequest', 'iwr',
    'invoke-restmethod', 'irm', 'start-bitstransfer', 'test-netconnection', 'wsman',
  ].includes(view.executable)) {
    return true;
  }
  if (view.executable === 'git'
    && ['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule'].includes(second)) {
    return true;
  }
  return ['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'cargo', 'gem'].includes(view.executable)
    && ['install', 'add', 'update', 'publish', 'search', 'login'].includes(second);
}

const NETWORK_MARKERS = [
  'invoke-webrequest', 'invoke-restmethod', 'start-bitstransfer', 'net.webclient', 'net.sockets',
  'system.net.http', 'http://', 'https://',
];

function containsNetworkMarker(command: string): boolean {
  const lower = asciiLower(command);
  return NETWORK_MARKERS.some(marker => lower.includes(marker));
}

function commandViewIsWriteCapable(view: PolicyCommandView): boolean {
  if (view.packageRunner
    || view.arbitraryPayload
    || isScriptRunnerToken(view.executable)
    || isPathExecutableToken(view.words[view.effectiveIndex] ?? view.executable)) {
    return true;
  }
  const second = asciiLower(view.words[view.effectiveIndex + 1] ?? '');
  const writesNetworkOutput = (view.executable === 'curl' || view.executable === 'wget')
    && view.words.slice(view.effectiveIndex + 1).some(word =>
      ['-o', '-O', '--output', '--output-dir', '--output-document'].includes(word)
      || word.startsWith('--output=')
      || word.startsWith('--output-dir=')
      || word.startsWith('--output-document='));
  if (writesNetworkOutput) return true;
  if ([
    'rm', 'del', 'erase', 'rmdir', 'rd', 'mv', 'move', 'cp', 'copy', 'mkdir', 'md', 'touch', 'tee',
    'remove-item', 'move-item', 'copy-item', 'rename-item', 'set-content', 'add-content',
    'out-file', 'new-item', 'ni', 'ln', 'install', 'truncate', 'dd', 'unzip', 'unrar', '7z',
    'chmod', 'chown', 'rsync',
  ].includes(view.executable)) {
    return true;
  }
  if (view.executable === 'git'
    && [
      'checkout', 'reset', 'clean', 'restore', 'merge', 'rebase', 'commit', 'apply', 'stash',
      'pull', 'add', 'rm', 'mv',
    ].includes(second)) {
    return true;
  }
  if (['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'cargo', 'gem'].includes(view.executable)
    && ['install', 'add', 'update', 'remove', 'uninstall', 'exec', 'x', 'run'].includes(second)) {
    return true;
  }
  if (view.executable === 'sed'
    && view.words.slice(view.effectiveIndex + 1)
      .some(word => word === '-i' || word.startsWith('-i') || word.startsWith('--in-place'))) {
    return true;
  }
  return view.executable === 'tar'
    && view.words.slice(view.effectiveIndex + 1)
      .some(word => word === '-x' || word.startsWith('-x') || word === '--extract');
}

function hasWriteRedirection(command: string): boolean {
  let quote: string | null = null;
  let escaped = false;
  for (const ch of command) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && quote !== '\'') { escaped = true; continue; }
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"') quote = ch;
    else if (ch === '>') return true;
  }
  return false;
}

function policyPathCandidate(token: string): string | null {
  const trimmed = token
    .replace(/^['"`;,\[\]()]+/, '')
    .replace(/['"`;,\[\]()]+$/, '');
  if (trimmed === ''
    || ['>', '>>', '<', '<<', '--'].includes(trimmed)
    || (trimmed.startsWith('-') && !trimmed.includes('='))) {
    return null;
  }
  const equals = trimmed.indexOf('=');
  const candidate = equals >= 0 ? trimmed.slice(equals + 1) : trimmed;
  if (candidate === '' || candidate.includes('://') || candidate.startsWith('data:') || candidate.startsWith('mailto:')) {
    return null;
  }
  if ((globalThis as { process?: { platform?: string } }).process?.platform === 'win32'
    && candidate.startsWith('/')
    && candidate.length <= 4
    && /^[A-Za-z?]+$/.test(candidate.slice(1))) {
    return null;
  }
  return candidate;
}

function commandViewPathOperands(view: PolicyCommandView): string[] {
  const operands: string[] = [];
  for (const word of view.words.slice(view.effectiveIndex + 1)) {
    const candidate = policyPathCandidate(word);
    if (candidate !== null) operands.push(candidate);
  }
  return operands;
}

function containsShellOperator(trimmed: string): boolean {
  return DANGEROUS_SHELL_OPERATORS.some(operator => trimmed.includes(operator));
}

export function analyzeShellCommand(cmd: string): ShellCommandAnalysis {
  const trimmed = rustTrim(cmd).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const hasShellOperators = containsShellOperator(trimmed);
  const segments = lexShellCommandSegments(trimmed);
  const views: PolicyCommandView[] = [];
  for (const words of segments) {
    const view = policyCommandView(words);
    if (view !== null) views.push(view);
  }
  const firstToken = segments[0]?.[0] ?? null;
  const effectiveFirstToken = views[0]?.executable ?? null;
  const usesScriptRunner = views.some(view =>
    view.wrappers.length > 0
    || view.packageRunner
    || view.arbitraryPayload
    || isScriptRunnerToken(view.executable));
  const networkCapable = views.some(commandViewIsNetworkCapable) || containsNetworkMarker(trimmed);
  const writeCapable = hasWriteRedirection(trimmed) || views.some(commandViewIsWriteCapable);
  const operandSet = new Set<string>();
  for (const view of views) for (const operand of commandViewPathOperands(view)) operandSet.add(operand);
  const pathOperands = sortedStrings(operandSet);
  let commandPref: string;
  if (trimmed === '') commandPref = '__empty__';
  else if (hasShellOperators || usesScriptRunner) commandPref = rawHash(trimmed);
  else commandPref = rustSplitWhitespace(trimmed).slice(0, 2).join(' ');

  return {
    trimmed,
    commandPrefix: commandPref,
    hasShellOperators,
    usesScriptRunner,
    firstToken,
    effectiveFirstToken,
    networkCapable,
    writeCapable,
    pathOperands,
  };
}


function commandPrefix(cmd: string): string {
  return analyzeShellCommand(cmd).commandPrefix;
}
