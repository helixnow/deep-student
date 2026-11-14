/** Shell 命令 guard、敏感度与路径约束：移植 approval_scope.rs 的 guard 分支。 */
import { isAbsolute, join, sep } from '../../../../platform/util/path.ts';
import { asciiLower } from '../runtime-path-values.ts';
import { rustTrim, isRustWhitespace } from '../../../../platform/util/index.ts';
import {
  trimEndSlashes,
} from './core.ts';
import {
  ShellCommandGuardEffect, type ShellCommandGuardDecision, type ShellCommandAnalysis,
  ToolSensitivity,
} from './core.ts';
import { analyzeShellCommand, commandPrefix, lexShellCommandSegments, policyCommandView,
  type PolicyCommandView } from './shell-analysis.ts';

function shellTextIsLexicallyComplete(command: string): boolean {
  let quote: string | null = null;
  let escaped = false;
  for (const ch of command) {
    if (escaped) { escaped = false; continue; }
    if (quote === '\'') {
      if (ch === '\'') quote = null;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\') escaped = true;
    } else if (ch === '\'' || ch === '"') {
      quote = ch;
    } else if (ch === '\\') {
      escaped = true;
    }
  }
  return quote === null && !escaped;
}

function guardTokenLower(token: string): string {
  let value = rustTrim(token);
  value = value.replace(/^["'`]+/, '').replace(/["'`]+$/, '');
  return asciiLower(value.replaceAll('\\', '/'));
}

function guardHasFlag(args: string[], short: string, long: string): boolean {
  return args.some(arg => {
    const lower = guardTokenLower(arg);
    return lower === long || (lower.startsWith('-') && !lower.startsWith('--') && lower.slice(1).includes(short.toLowerCase()));
  });
}

type GuardPathClass = 'root_like' | 'unresolvable' | 'other';

/**
 * `std::fs::canonicalize` 只在桌面有（`node:fs`）。guard 本身不读写文件系统：桌面入口把
 * `canonicalPath` 注入这里，未注入时按词法规整（不解析符号链接），guard 的判定仍保持原样。
 */
export type ShellGuardCanonicalizer = (value: string) => string;
let canonicalizer: ShellGuardCanonicalizer | null = null;
export function setShellGuardCanonicalizer(fn: ShellGuardCanonicalizer | null): void {
  canonicalizer = fn;
}

function canonicalOrLexical(value: string): string {
  try {
    return canonicalizer === null ? lexicalNormalizePath(value) : canonicalizer(value);
  } catch { return lexicalNormalizePath(value); }
}

export function lexicalNormalizePath(value: string): string {
  const driveMatch = /^([A-Za-z]:)[\\/]/.exec(value);
  const drive = driveMatch?.[1] ?? '';
  const absolute = isAbsolute(value);
  const body = drive !== '' ? value.slice(2) : value;
  const parts = body.split(/[\\/]/);
  const output: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { output.pop(); continue; }
    output.push(part);
  }
  const joined = output.join(sep);
  if (drive !== '') return `${drive}${sep}${joined}`;
  if (absolute) return `${sep}${joined}`;
  return joined;
}

function classifyGuardPath(token: string, cwd: string | null, protectedRoots: string[]): GuardPathClass {
  const normalized = guardTokenLower(token);
  const literalRootLike = new Set([
    '/', '/*', '.', './', '~', '~/', '$home', '${home}', '%userprofile%', '$env:userprofile',
    '$pwd', '${pwd}', '$(pwd)', '`pwd`', '%cd%', '\\',
  ]);
  if (literalRootLike.has(normalized)) return 'root_like';
  if (normalized.length === 3 && normalized[1] === ':' && normalized[2] === '/') return 'root_like';
  if (normalized.length === 4 && normalized[1] === ':' && normalized.slice(2) === '/*') return 'root_like';
  const literalGlobRootLike = new Set([
    '$home/*', '${home}/*', '~/*', '%userprofile%/*', '$env:userprofile/*', '$pwd/*',
    '${pwd}/*', '$(pwd)/*', '%cd%/*',
  ]);
  if (literalGlobRootLike.has(normalized) || normalized.startsWith('${home:')) return 'root_like';

  const normalizedNoTail = trimEndSlashes(normalized);
  const matchesPath = (candidatePath: string): boolean => {
    const candidate = asciiLower(candidatePath.replaceAll('\\', '/'));
    return normalizedNoTail === trimEndSlashes(candidate);
  };

  if (cwd !== null) {
    if ((normalized === '*' || normalized === './*')
      && protectedRoots.some(root => canonicalOrLexical(root) === canonicalOrLexical(cwd))) {
      return 'root_like';
    }
    const firstChar = token[0];
    const hasExpansionPrefix = firstChar === '~' || firstChar === '$' || firstChar === '%';
    if (!hasExpansionPrefix && !token.includes('`')) {
      const candidate = isAbsolute(token) ? token : join(cwd, token);
      const resolved = canonicalOrLexical(candidate);
      if (protectedRoots.some(root => canonicalOrLexical(root) === resolved)) return 'root_like';
    }
  }
  if ((cwd !== null && matchesPath(cwd)) || protectedRoots.some(root => matchesPath(root))) {
    return 'root_like';
  }
  if (token.includes('$(')
    || token.includes('`')
    || normalized.startsWith('$')
    || normalized.startsWith('%')
    || (normalized.startsWith('~') && !normalized.startsWith('~/'))
    || normalized === '*'
    || normalized === './*') {
    return 'unresolvable';
  }
  return 'other';
}

function guardPathIsRootLike(token: string, cwd: string | null, protectedRoots: string[]): boolean {
  return classifyGuardPath(token, cwd, protectedRoots) === 'root_like';
}

function guardViewIsCatastrophic(
  view: PolicyCommandView,
  cwd: string | null,
  protectedRoots: string[],
): string | null {
  const args = view.words.slice(Math.min(view.effectiveIndex + 1, view.words.length));
  switch (view.executable) {
    case 'rm': {
      const recursive = guardHasFlag(args, 'r', '--recursive');
      if (recursive
        && args.filter(arg => !arg.startsWith('-')).some(arg => guardPathIsRootLike(arg, cwd, protectedRoots))) {
        return 'catastrophic_recursive_delete';
      }
      break;
    }
    case 'remove-item':
    case 'ri': {
      const recursive = args.some(arg => {
        const lower = guardTokenLower(arg);
        return lower === '-recurse' || lower === '-r';
      });
      if (recursive
        && args.filter(arg => !arg.startsWith('-')).some(arg => guardPathIsRootLike(arg, cwd, protectedRoots))) {
        return 'catastrophic_recursive_delete';
      }
      break;
    }
    case 'del':
    case 'erase':
    case 'rd':
    case 'rmdir': {
      const recursive = args.some(arg => ['/s', '-s', '/s/q', '/q/s'].includes(guardTokenLower(arg)));
      if (recursive
        && args.filter(arg => !arg.startsWith('-')
          && !(arg.startsWith('/') && !guardPathIsRootLike(arg, cwd, protectedRoots)))
          .some(arg => guardPathIsRootLike(arg, cwd, protectedRoots))) {
        return 'catastrophic_recursive_delete';
      }
      break;
    }
    default:
      break;
  }
  if (view.executable.startsWith('mkfs')) return 'filesystem_format';
  if (view.executable === 'format-volume' || view.executable === 'clear-disk' || view.executable === 'diskpart') {
    return 'disk_destructive';
  }
  if (view.executable === 'diskutil') {
    if (args.some(arg => [
      'erasedisk', 'erasevolume', 'partitiondisk', 'zerodisk', 'randomdisk', 'deletecontainer',
    ].includes(guardTokenLower(arg)))) {
      return 'disk_destructive';
    }
  }
  if (view.executable === 'dd') {
    if (args.some(arg => {
      const lower = guardTokenLower(arg);
      return lower.startsWith('of=/dev/disk')
        || lower.startsWith('of=/dev/rdisk')
        || lower.startsWith('of=/dev/sd')
        || lower.startsWith('of=//./physicaldrive');
    })) {
      return 'raw_disk_write';
    }
  }
  if (view.executable === 'vssadmin') {
    if (args.map(guardTokenLower).some(arg => arg === 'delete')) return 'snapshot_destruction';
  }
  if (view.executable === 'cipher') {
    if (args.map(guardTokenLower).some(arg => arg === '/w' || arg.startsWith('/w:'))) return 'free_space_wipe';
  }
  if (view.executable === 'bcdedit') {
    if (args.some(arg => ['/delete', '-delete', '/deletevalue', '-deletevalue', '/import', '-import',
      '/createstore', '-createstore'].includes(guardTokenLower(arg)))) {
      return 'boot_configuration_change';
    }
  }
  if (['shutdown', 'reboot', 'halt', 'poweroff', 'stop-computer', 'restart-computer'].includes(view.executable)) {
    return 'system_shutdown';
  }
  return null;
}

function guardLiteralNestedPayload(view: PolicyCommandView): string | null {
  const args = view.words.slice(Math.min(view.effectiveIndex + 1, view.words.length));
  const payloadAfterFlag = (flags: string[]): string | null => {
    for (let index = 0; index < args.length; index++) {
      const lower = guardTokenLower(args[index]!);
      if (flags.includes(lower)) {
        const payload = args.slice(index + 1).join(' ');
        if (rustTrim(payload) !== '') return payload;
        return null;
      }
    }
    return null;
  };

  if (['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish'].includes(view.executable)) {
    const payload = payloadAfterFlag(['-c', '--command']);
    if (payload !== null) return payload;
    for (let index = 0; index < args.length; index++) {
      const lower = guardTokenLower(args[index]!);
      if (lower.startsWith('-') && !lower.startsWith('--') && lower.slice(1).includes('c')) {
        const payload = args.slice(index + 1).join(' ');
        if (rustTrim(payload) !== '') return payload;
      }
    }
    return null;
  }
  if (view.executable === 'powershell' || view.executable === 'pwsh') {
    return payloadAfterFlag(['-command', '/command', '-c', '/c']);
  }
  if (view.executable === 'cmd') return payloadAfterFlag(['/c', '-c', '/k', '-k']);
  if (view.executable === 'eval' || view.executable === 'iex' || view.executable === 'invoke-expression') {
    const payload = args.join(' ');
    return rustTrim(payload) !== '' ? payload : null;
  }
  return null;
}

function guardCatastrophicReason(
  command: string,
  cwd: string | null,
  protectedRoots: string[],
  depth: number,
): string | null {
  if (depth > 4) return null;
  let compact = '';
  for (const ch of command) if (!isRustWhitespace(ch.codePointAt(0) ?? 0)) compact += ch;
  if (compact.includes(':(){:|:&};:')) return 'fork_bomb';
  const segments = lexShellCommandSegments(command);
  const views: PolicyCommandView[] = [];
  for (const words of segments) {
    const view = policyCommandView(words);
    if (view !== null) views.push(view);
  }
  for (const view of views) {
    const reason = guardViewIsCatastrophic(view, cwd, protectedRoots);
    if (reason !== null) return reason;
  }
  for (const view of views) {
    const payload = guardLiteralNestedPayload(view);
    if (payload !== null) {
      const reason = guardCatastrophicReason(payload, cwd, protectedRoots, depth + 1);
      if (reason !== null) return reason;
    }
  }
  return null;
}

function guardViewRequiresApproval(
  view: PolicyCommandView,
  cwd: string | null,
  protectedRoots: string[],
): string | null {
  const args = view.words.slice(Math.min(view.effectiveIndex + 1, view.words.length));
  const lowerArgs = args.map(guardTokenLower);
  if (view.wrappers.some(wrapper => wrapper === 'sudo' || wrapper === 'doas')
    || view.executable === 'sudo' || view.executable === 'doas' || view.executable === 'su') {
    return 'privilege_escalation';
  }
  const unixShellWithPayload = ['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish'].includes(view.executable)
    && lowerArgs.some(arg => arg === '--command'
      || (arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes('c')));
  if (view.arbitraryPayload
    || unixShellWithPayload
    || ['eval', 'iex', 'invoke-expression', 'invoke-command', 'powershell', 'pwsh', 'cmd',
      'wscript', 'cscript', 'mshta'].includes(view.executable)) {
    return 'dynamic_or_encoded_execution';
  }
  let recursiveDelete: boolean;
  if (view.executable === 'rm') recursiveDelete = guardHasFlag(args, 'r', '--recursive');
  else if (view.executable === 'remove-item' || view.executable === 'ri') {
    recursiveDelete = lowerArgs.some(arg => arg === '-recurse' || arg === '-r');
  } else if (['del', 'erase', 'rd', 'rmdir'].includes(view.executable)) {
    recursiveDelete = lowerArgs.some(arg => ['/s', '-s', '/s/q', '/q/s'].includes(arg));
  } else recursiveDelete = false;
  if (recursiveDelete
    && args.filter(arg => !arg.startsWith('-'))
      .some(arg => classifyGuardPath(arg, cwd, protectedRoots) === 'unresolvable')) {
    return 'unresolvable_recursive_delete';
  }
  if (view.executable === 'git') {
    const force = lowerArgs.some(arg =>
      ['--force', '-f', '--force-with-lease', '--mirror'].includes(arg)
      || arg.startsWith('--force=')
      || arg.startsWith('--force-with-lease='));
    const cleanHas = (flag: string): boolean => lowerArgs.some(arg =>
      arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes(flag));
    if ((lowerArgs.includes('push') && force)
      || (lowerArgs.includes('reset') && lowerArgs.includes('--hard'))
      || (lowerArgs.includes('clean') && cleanHas('f') && cleanHas('d') && cleanHas('x'))) {
      return 'high_risk_git';
    }
  }
  if ((view.executable === 'terraform' && lowerArgs.includes('destroy'))
    || (view.executable === 'pulumi' && (lowerArgs.includes('destroy') || lowerArgs.includes('up')))) {
    return 'infrastructure_change';
  }
  if (view.executable === 'kubectl'
    && lowerArgs.includes('delete')
    && lowerArgs.some(arg => [
      'namespace', 'namespaces', 'node', 'nodes', 'crd', 'customresourcedefinition',
      'customresourcedefinitions', 'clusterrole', 'clusterroles', 'clusterrolebinding',
      'clusterrolebindings', '--all', '-a',
    ].includes(arg))) {
    return 'cluster_level_delete';
  }
  if (['aws', 'gcloud', 'az', 'helm', 'pulumi', 'terraform'].includes(view.executable)
    && lowerArgs.some(arg => [
      'delete', 'destroy', 'apply', 'deploy', 'release', 'publish', 'push', 'upgrade', 'uninstall',
    ].includes(arg))) {
    return 'cloud_or_release_change';
  }
  if (['npm', 'pnpm', 'yarn', 'cargo', 'gem', 'docker', 'twine', 'gh'].includes(view.executable)
    && lowerArgs.some(arg => ['publish', 'push', 'release'].includes(arg))) {
    return 'artifact_publish';
  }
  if (view.executable === 'docker'
    && lowerArgs.some(arg => ['prune', 'rm', 'rmi'].includes(arg))) {
    return 'container_destructive';
  }
  if (['sysctl', 'launchctl', 'systemctl', 'sc', 'reg', 'netsh', 'bcdedit', 'update-bootconfigurationdata']
    .includes(view.executable)
    || (view.executable === 'defaults'
      && lowerArgs.some(arg => arg === 'write' || arg === 'delete'))) {
    return 'system_configuration';
  }
  const sql = lowerArgs.join(' ');
  if (sql.split(/[^A-Za-z0-9_]/).some(word => word === 'drop' || word === 'truncate')
    || view.executable === 'drop' || view.executable === 'truncate') {
    return 'destructive_database_statement';
  }
  return null;
}

function gitReadonlySubcommand(args: string[]): boolean {
  let index = 0;
  while (index < args.length) {
    const arg = guardTokenLower(args[index]!);
    const takesValue = [
      '-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix',
    ].includes(arg);
    if (takesValue) { index += 2; continue; }
    if (arg.startsWith('-c')
      || arg.startsWith('--git-dir=')
      || arg.startsWith('--work-tree=')
      || arg.startsWith('--namespace=')
      || arg.startsWith('--config-env=')
      || arg.startsWith('--super-prefix=')
      || (arg.startsWith('-') && arg !== '--')) {
      index += 1;
      continue;
    }
    if (arg === '--') { index += 1; continue; }
    return [
      'status', 'log', 'show', 'diff', 'blame', 'grep', 'ls-files', 'ls-tree', 'cat-file',
      'rev-parse', 'describe', 'shortlog', 'whatchanged', 'version', 'help',
    ].includes(arg);
  }
  return false;
}

const READONLY_SHELL_FAMILY = new Set([
  'ls', 'dir', 'cat', 'head', 'tail', 'wc', 'stat', 'which', 'where', 'where.exe', 'whoami', 'id',
  'uname', 'realpath', 'readlink', 'pwd', 'echo', 'printf', 'date', 'true', 'false', 'basename',
  'dirname', 'file', 'strings', 'nl', 'tree', 'du', 'df', 'env', 'printenv', 'type', 'grep',
  'egrep', 'fgrep', 'rg', 'ag', 'get-childitem', 'gci', 'get-content', 'gc', 'get-item', 'gi',
  'get-location', 'gl', 'select-string', 'write-output', 'get-process', 'gps',
]);

function shellExecutableIsReadonlyFamily(view: PolicyCommandView): boolean {
  const args = view.words.slice(Math.min(view.effectiveIndex + 1, view.words.length));
  if (READONLY_SHELL_FAMILY.has(view.executable)) return true;
  if (view.executable === 'git') return gitReadonlySubcommand(args);
  return false;
}

/** Resolve the tool-approval sensitivity for a concrete local shell command. */
export function shellCommandToolSensitivity(command: string): ToolSensitivity {
  const analysis = analyzeShellCommand(command);
  if (analysis.trimmed === ''
    || analysis.writeCapable
    || analysis.networkCapable
    || analysis.hasShellOperators
    || analysis.usesScriptRunner) {
    return ToolSensitivity.High;
  }
  if (immutableShellCommandGuard(analysis.trimmed, null, []).effect !== ShellCommandGuardEffect.Allow) {
    return ToolSensitivity.High;
  }
  const firstView = lexShellCommandSegments(analysis.trimmed)
    .slice(0, 1)
    .map(words => policyCommandView(words))
    .find((candidate): candidate is PolicyCommandView => candidate !== null) ?? null;
  if (firstView !== null && shellExecutableIsReadonlyFamily(firstView)) return ToolSensitivity.Medium;
  return ToolSensitivity.High;
}

/** Classify a shell command; catastrophic → deny, high-risk/ambiguous → ask. */
export function immutableShellCommandGuard(
  command: string,
  cwd: string | null,
  protectedRoots: readonly string[],
): ShellCommandGuardDecision {
  const roots = [...protectedRoots];
  const analysis = analyzeShellCommand(command);
  if (analysis.trimmed === '') {
    return { effect: ShellCommandGuardEffect.Deny, reason: 'empty_command' };
  }
  const catastrophic = guardCatastrophicReason(analysis.trimmed, cwd, roots, 0);
  if (catastrophic !== null) {
    return { effect: ShellCommandGuardEffect.Deny, reason: catastrophic };
  }
  const segments = lexShellCommandSegments(analysis.trimmed);
  const views: PolicyCommandView[] = [];
  for (const words of segments) {
    const view = policyCommandView(words);
    if (view !== null) views.push(view);
  }
  for (const view of views) {
    const reason = guardViewRequiresApproval(view, cwd, roots);
    if (reason !== null) return { effect: ShellCommandGuardEffect.Ask, reason };
  }
  if (!shellTextIsLexicallyComplete(analysis.trimmed)
    || views.length !== segments.length
    || analysis.hasShellOperators
    || analysis.usesScriptRunner) {
    return { effect: ShellCommandGuardEffect.Ask, reason: 'complex_or_unparseable_command' };
  }
  return { effect: ShellCommandGuardEffect.Allow, reason: 'ordinary_command' };
}
