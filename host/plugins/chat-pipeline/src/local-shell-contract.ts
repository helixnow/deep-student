import type { LocalShellRuntimeContract } from '../api.ts';

/** Rust context.rs:45-92. Input uses Rust target_os names, not Node platform names. */
export function localShellContractForPlatform(platform: string): LocalShellRuntimeContract {
  switch (platform) {
    case 'macos': return { os: 'macOS', sandbox_backend: 'macos_seatbelt', shell_path: '/bin/sh',
      shell_kind: 'posix_sh', invocation: '/bin/sh -c', output_encoding: 'utf-8', execution_supported: true };
    case 'windows': return { os: 'Windows', sandbox_backend: 'windows_appcontainer_job',
      shell_path: 'Program Files\\PowerShell\\7\\pwsh.exe (preferred), System32\\WindowsPowerShell\\v1.0\\powershell.exe (fallback)',
      shell_kind: 'windows_powershell',
      invocation: 'pwsh.exe -NoProfile -NonInteractive -EncodedCommand; fallback powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand',
      output_encoding: 'utf-8', execution_supported: true };
    case 'linux': return { os: 'Linux', sandbox_backend: 'linux_bwrap', shell_path: '/bin/sh',
      shell_kind: 'posix_sh', invocation: '/bin/sh -c', output_encoding: 'utf-8', execution_supported: true };
    default: return { os: 'Unsupported', sandbox_backend: 'unavailable', shell_path: null,
      shell_kind: 'unavailable', invocation: null, output_encoding: 'unknown', execution_supported: false };
  }
}
