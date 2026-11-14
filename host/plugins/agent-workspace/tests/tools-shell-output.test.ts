import { expect, it } from 'vitest';
import {
  failureErrorForLlm, platformExitDetails, posixSyntaxHintsForPowershell,
  normalizePlatformShellStderr, truncateOutput, WINDOWS_SHELL_KIND_MARKER,
} from '../src/tools/shell-output.ts';

it('truncates_stdout_by_bytes', () => {
  const [text, truncated, bytes] = truncateOutput(Buffer.from('abcdef'), 3);
  expect(text).toBe('abc');
  expect(truncated).toBe(true);
  expect(bytes).toBe(6);
});

it('truncated_utf8_output_keeps_valid_utf8_prefix', () => {
  const bytes = Buffer.from('prefix-中');
  const [text, truncated, total] = truncateOutput(bytes, bytes.length - 1);
  expect(truncated).toBe(true);
  expect(total).toBe(bytes.length);
  expect(text.startsWith('prefix-')).toBe(true);
  expect(text).not.toContain('涓');
});

const windowsIt = process.platform === 'win32' ? it : it.skip;
windowsIt('shell_kind_marker_discards_probe_stderr_and_reports_actual_shell', () => {
  const stderr = `pwsh startup failed\r\n${WINDOWS_SHELL_KIND_MARKER}windows_powershell_5_1\r\nreal 5.1 stderr`;
  const [normalized, shellKind] = normalizePlatformShellStderr(stderr);
  expect(normalized).toBe('real 5.1 stderr');
  expect(shellKind).toBe('windows_powershell_5_1');
});

windowsIt('windows_init_failure_exit_code_is_reported_unsigned_and_hex', () => {
  const [unsigned, hex, startupFailure] = platformExitDetails(-65536);
  expect(unsigned).toBe(0xffff0000);
  expect(hex).toBe('0xFFFF0000');
  expect(startupFailure).toBe(true);
});

it('failure_error_for_llm_includes_exit_code_and_stderr_tail', () => {
  const output = {
    success: false,
    exit_code: 126,
    timed_out: false,
    cancelled: false,
    timeout_ms: 30_000,
    stdout: 'partial output',
    stderr: 'Windows local shell sandbox failed: access denied',
  };
  const error = failureErrorForLlm(output);
  expect(error).toContain('Exit code 126');
  expect(error).toContain('access denied');
  expect(error).toContain('inspect the cause');
  expect(!error.includes('partial output') || error.includes('stdout (tail)')).toBe(true);
});

it('failure_error_for_llm_explains_powershell_startup_failure', () => {
  const output = {
    success: false,
    exit_code: -65_536,
    exit_code_hex: '0xFFFF0000',
    shell_startup_failure: true,
    timed_out: false,
    cancelled: false,
    stdout: '',
    stderr: 'The shell cannot be started.',
  };
  const error = failureErrorForLlm(output);
  expect(error).toContain('Exit code -65536 (0xFFFF0000)');
  expect(error).toContain('engine initialization');
});

it('failure_error_for_llm_marks_timeout_and_unknown_exit', () => {
  const timedOut = {
    success: false, exit_code: null, timed_out: true, cancelled: false,
    timeout_ms: 120_000, stdout: '', stderr: '',
  };
  expect(failureErrorForLlm(timedOut)).toContain('timed out after 120000ms');
  const noDetail = {
    success: false, exit_code: null, timed_out: false, cancelled: false, stdout: '', stderr: '',
  };
  expect(failureErrorForLlm(noDetail)).toContain('Exit code <unknown>');
});

it('failure_error_for_llm_truncates_long_stderr_by_tail', () => {
  const longStderr = `${'x'.repeat(5000)}TAIL_MARKER`;
  const output = {
    success: false, exit_code: 1, timed_out: false, cancelled: false,
    stdout: '', stderr: longStderr,
  };
  const error = failureErrorForLlm(output);
  expect(error).toContain('TAIL_MARKER');
  expect(error.length).toBeLessThan(3000);
});

it('posix_syntax_hints_cover_common_bash_isms', () => {
  const hints = posixSyntaxHintsForPowershell('export A=1 && rm -rf target && grep -r foo .');
  expect(hints.some(hint => hint.includes('&&'))).toBe(true);
  expect(hints.some(hint => hint.includes('$env:'))).toBe(true);
  expect(hints.some(hint => hint.includes('Remove-Item'))).toBe(true);
  expect(hints.some(hint => hint.includes('Select-String'))).toBe(true);

  const second = posixSyntaxHintsForPowershell('which node; touch out.txt');
  expect(second.some(hint => hint.includes('Get-Command'))).toBe(true);
  expect(second.some(hint => hint.includes('New-Item'))).toBe(true);

  expect(posixSyntaxHintsForPowershell('Get-ChildItem | Select-Object -First 5')).toEqual([]);
  expect(posixSyntaxHintsForPowershell('cargo run --bin exporter')).toEqual([]);
});

it('failure_error_includes_powershell_hints_only_for_windows_shell', () => {
  const command = 'npm install && npm run build';
  const windowsOutput = {
    success: false, exit_code: 1, timed_out: false, cancelled: false, stdout: '',
    stderr: '所在位置 行:1 字符: 12 附近的标记“&&”不是有效的语句分隔符。',
    command,
    sandbox: { shell_kind: 'windows_powershell' },
  };
  const error = failureErrorForLlm(windowsOutput);
  expect(error).toContain('PowerShell syntax hints');
  expect(error).toContain('if ($?)');

  const posixOutput = {
    success: false, exit_code: 1, timed_out: false, cancelled: false, stdout: '',
    stderr: 'some error', command, sandbox: { shell_kind: 'posix_sh' },
  };
  expect(failureErrorForLlm(posixOutput)).not.toContain('PowerShell syntax hints');

  const pwshOutput = {
    success: false, exit_code: 1, timed_out: false, cancelled: false, stdout: '',
    stderr: 'some error', command, sandbox: { shell_kind: 'windows_powershell_7' },
  };
  expect(failureErrorForLlm(pwshOutput)).not.toContain('PowerShell syntax hints');
});
