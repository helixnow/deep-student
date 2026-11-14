/**
 * Shell 输出/失败信息纯函数：移植 `local_shell_execute_executor.rs` 的
 * `truncate_output` / `decode_shell_output` / `failure_error_for_llm` /
 * `posix_syntax_hints_for_powershell` / `platform_exit_details` /
 * `normalize_platform_shell_stderr`。
 */
import type { JsonValue } from './shared.ts';
import { rustTrim } from '../../../../platform/util/index.ts';

export const WINDOWS_SHELL_KIND_MARKER = '__DEEP_STUDENT_SHELL_KIND__=';

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nested(value: Record<string, unknown>, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    const currentObject = object(current);
    if (!currentObject) return undefined;
    current = currentObject[key];
  }
  return current;
}

/** UTF-8 安全的尾部截取（按字符数）。 */
export function tailChars(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(chars.length - maxChars).join('');
}

/** `decode_shell_output`：非 Windows 为 UTF-8 lossy。 */
export function decodeShellOutput(bytes: Buffer): string {
  return bytes.toString('utf8');
}

export function truncateOutput(bytes: Buffer, maxBytes: number): [string, boolean, number] {
  const totalBytes = bytes.length;
  const truncated = totalBytes > maxBytes;
  const visible = truncated ? bytes.subarray(0, maxBytes) : bytes;
  return [decodeShellOutput(visible), truncated, totalBytes];
}

function hasWord(command: string, word: string): boolean {
  const bytes = Buffer.from(command, 'utf8');
  const wordBytes = Buffer.from(word, 'utf8');
  let index = bytes.indexOf(wordBytes);
  while (index !== -1) {
    const before = index === 0 ? 0x20 : bytes[index - 1]!;
    const afterIndex = index + wordBytes.length;
    const after = afterIndex >= bytes.length ? 0x20 : bytes[afterIndex]!;
    const isAlnum = (value: number) => (value >= 0x30 && value <= 0x39)
      || (value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a);
    if (!isAlnum(before) && !isAlnum(after)) return true;
    index = bytes.indexOf(wordBytes, index + 1);
  }
  return false;
}

/** 常见 bash 语法 → PowerShell 写法的提示（仅失败时附加）。 */
export function posixSyntaxHintsForPowershell(command: string): string[] {
  const hints: string[] = [];
  if (command.includes('&&') || command.includes('||')) {
    hints.push('PowerShell 5.1 不支持 `&&`/`||`：改用 `;` 顺序分隔，或用 `if ($?) { ... }` 判断上一条是否成功');
  }
  if (hasWord(command, 'export')) {
    hints.push('`export X=Y` 是 bash 语法：PowerShell 用 `$env:X = "Y"` 设置环境变量');
  }
  if (command.includes('rm -rf') || command.includes('rm -fr')
    || command.includes('rm -r ') || command.includes('Remove-Item -rf')) {
    hints.push('`rm -rf` 在 PowerShell 5.1 中无效：用 `Remove-Item -Recurse -Force <path>`');
  }
  if (hasWord(command, 'grep')) {
    hints.push('`grep` 不存在：用 `Select-String -Pattern <模式>`');
  }
  if (hasWord(command, 'sed') || hasWord(command, 'awk')) {
    hints.push('`sed`/`awk` 不存在：用 `-replace` 运算符或 `Select-String`');
  }
  if (hasWord(command, 'touch')) {
    hints.push('`touch` 不存在：用 `New-Item -ItemType File -Force -Path <path>`');
  }
  if (hasWord(command, 'which')) {
    hints.push('`which` 不存在：用 `Get-Command <name>`');
  }
  if (command.replace(/^\p{White_Space}+/u, '').startsWith('#!')) {
    hints.push('shebang（#!/...）在 PowerShell 中无效：直接写脚本命令');
  }
  return hints;
}

/** 命令失败时回传给 LLM 的错误摘要。 */
export function failureErrorForLlm(output: JsonValue): string {
  const STDERR_TAIL_CHARS = 2000;
  const STDOUT_TAIL_CHARS = 500;
  const value = object(output) ?? {};
  const parts: string[] = [];
  const timedOut = value.timed_out === true;
  const cancelled = value.cancelled === true;
  const exitCode = typeof value.exit_code === 'number' && Number.isInteger(value.exit_code)
    ? value.exit_code as number
    : null;
  if (timedOut) {
    const timeoutMs = typeof value.timeout_ms === 'number' ? value.timeout_ms as number : 0;
    parts.push(`Command timed out after ${timeoutMs}ms and was killed.`);
  } else if (cancelled) {
    parts.push('Command was cancelled.');
  }
  if (exitCode !== null) {
    const hex = typeof value.exit_code_hex === 'string' ? value.exit_code_hex as string : null;
    const codeLabel = hex === null ? String(exitCode) : `${exitCode} (${hex})`;
    parts.push(`Exit code ${codeLabel}`);
  } else if (!timedOut && !cancelled) {
    parts.push('Exit code <unknown>');
  }
  if (value.shell_startup_failure === true) {
    parts.push('PowerShell failed during engine initialization before the command ran.');
  }
  const stderr = typeof value.stderr === 'string' ? rustTrim(value.stderr as string) : '';
  if (stderr !== '') parts.push(`stderr (tail): ${tailChars(stderr, STDERR_TAIL_CHARS)}`);
  const stdout = typeof value.stdout === 'string' ? rustTrim(value.stdout as string) : '';
  if (stdout !== '') parts.push(`stdout (tail): ${tailChars(stdout, STDOUT_TAIL_CHARS)}`);
  const shellKind = nested(value, 'sandbox', 'shell_kind');
  const isLegacyPowershell = shellKind === 'windows_powershell' || shellKind === 'windows_powershell_5_1';
  if (isLegacyPowershell && typeof value.command === 'string') {
    const hints = posixSyntaxHintsForPowershell(value.command as string);
    if (hints.length > 0) parts.push(`PowerShell syntax hints:\n- ${hints.join('\n- ')}`);
  }
  parts.push(
    'Command execution was not successful; inspect the cause above and adjust the command instead of retrying it unchanged.',
  );
  return parts.join('\n');
}

/** 非 Windows 返回 (null, null, false)，与 Rust `cfg(not(windows))` 一致。 */
export function platformExitDetails(exitCode: number | null): [number | null, string | null, boolean] {
  if (process.platform !== 'win32') return [null, null, false];
  const unsigned = exitCode === null ? null : exitCode >>> 0;
  const hex = unsigned === null ? null : `0x${unsigned.toString(16).toUpperCase().padStart(8, '0')}`;
  return [unsigned, hex, unsigned === 0xffff0000];
}

/** 从 stderr 提取并移除 shell kind 标记（仅 Windows 会调用）。 */
export function normalizePlatformShellStderr(stderr: string): [string, string | null] {
  if (process.platform !== 'win32') return [stderr, null];
  const markerStart = stderr.indexOf(WINDOWS_SHELL_KIND_MARKER);
  if (markerStart === -1) return [stderr, null];
  const valueStart = markerStart + WINDOWS_SHELL_KIND_MARKER.length;
  const rest = stderr.slice(valueStart);
  const newlineOffset = rest.search(/[\r\n]/);
  const valueEnd = newlineOffset === -1 ? stderr.length : valueStart + newlineOffset;
  const rawKind = stderr.slice(valueStart, valueEnd);
  const shellKind = rawKind === 'windows_powershell_7' || rawKind === 'windows_powershell_5_1'
    ? rawKind
    : null;
  let remaining = stderr.slice(valueEnd);
  if (remaining.startsWith('\r\n')) remaining = remaining.slice(2);
  else if (remaining.startsWith('\n')) remaining = remaining.slice(1);
  if (shellKind !== null) {
    const lines = remaining.split(/(?<=\n)/);
    remaining = lines
      .filter(line => !line.replace(/\p{White_Space}+$/u, '').startsWith(WINDOWS_SHELL_KIND_MARKER))
      .join('');
    return [remaining, shellKind];
  }
  return [stderr, null];
}
