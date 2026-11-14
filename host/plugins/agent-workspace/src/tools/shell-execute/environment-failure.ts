/**
 * Local shell failures that happen before the command runs (resource limits, sandbox launcher, spawn, process pipes).
 * They are reported apart from the command's own outcome (non-zero exit, timeout, cancellation), which is a structured
 * result with an exit code; these carry no output at all.
 */
import { ioMessage } from '../../runtime-paths.ts';

/** Machine-readable start of every environment-failure message. */
export const SHELL_ENVIRONMENT_FAILURE_PREFIX = 'LOCAL_SHELL_ENVIRONMENT_FAILURE';

/**
 * - `resource_limits`: the RLIMIT launcher (nativeSandbox) is unavailable;
 * - `sandbox_setup`: the sandbox or shell launcher could not be prepared (Seatbelt profile, bwrap, Windows payload / PowerShell);
 * - `spawn`: the OS refused to start the process (EAGAIN, ENOENT, EACCES…);
 * - `process_io`: the process started without a process id or output pipes and was terminated.
 */
export type ShellEnvironmentStage = 'resource_limits' | 'sandbox_setup' | 'spawn' | 'process_io';

/** Resource exhaustion that can clear on its own. */
const TRANSIENT_CODES = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'EBUSY', 'ETXTBSY']);

// RUST-FIX(RF-S01-shell-environment-failure): Rust returns these as bare Err strings with no stage, errno or retry guidance
export class ShellEnvironmentFailure extends Error {
  override name = 'ShellEnvironmentFailure';
  readonly stage: ShellEnvironmentStage;
  /** errno code of the underlying failure (`EAGAIN`…), when there is one. */
  readonly code: string | null;
  /** The failure itself, without the classification and advice. */
  readonly detail: string;
  constructor(stage: ShellEnvironmentStage, detail: string, code: string | null, cause?: unknown) {
    super(environmentFailureMessage(stage, detail, code), cause === undefined ? undefined : { cause });
    this.stage = stage;
    this.code = code;
    this.detail = detail;
  }
}

/** A backend that could not prepare the command (Seatbelt profile, bwrap, Windows helper or PowerShell) ran nothing. */
export function sandboxSetupFailure(error: unknown): ShellEnvironmentFailure {
  return new ShellEnvironmentFailure('sandbox_setup', ioMessage(error), errnoCode(error), error);
}

export function errnoCode(error: unknown): string | null {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^E[A-Z0-9]+$/.test(code) ? code : null;
}

export function isTransientEnvironmentCode(code: string | null): boolean {
  return code !== null && TRANSIENT_CODES.has(code);
}

function environmentFailureMessage(stage: ShellEnvironmentStage, detail: string, code: string | null): string {
  const outcome = stage === 'process_io'
    ? 'The shell process was terminated before its output could be captured; there is no exit code or output.'
    : 'The command did not run, so there is no exit code or output and nothing was changed.';
  const advice = isTransientEnvironmentCode(code)
    ? `${code} means the system is temporarily out of processes, file descriptors or memory. Do not retry the same command `
      + 'right away: wait, retry at most once, and tell the user if it fails again.'
    : 'Retrying the same command will fail the same way. Do not retry it unchanged; tell the user that the local shell '
      + 'environment is not working and quote the reason above.';
  return `${SHELL_ENVIRONMENT_FAILURE_PREFIX} (stage=${stage}${code === null ? '' : `, code=${code}`}): ${detail}\n`
    + `This is a failure of the local shell execution environment, not of the command. ${outcome} ${advice}`;
}
