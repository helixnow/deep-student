import type { CommandContract } from '../../../kernel/contract.ts';
import type { ContractSet } from '../../../kernel/contracts.ts';
import { findNonJson } from '../../../kernel/json.ts';

export type ProbeResponse =
  | { timeout: true }
  | { panic: string }
  | { ok: true; value: unknown }
  | { ok: false; error: unknown };

export function classifyResponse(contracts: ContractSet, command: CommandContract & { file: string }, response: ProbeResponse) {
  if ('panic' in response) return { outcome: 'crash', category: 'panic', reason: response.panic };
  if ('timeout' in response) return { outcome: 'crash', category: 'timeout', reason: 'Promise did not settle within invocation budget' };
  const value = response.ok ? response.value : response.error;
  // This is already a production IPC result, not an internal service value.
  // F1 owns D3 BigInt -> JSON number conversion; never repair it in the probe.
  try { JSON.stringify(value); }
  catch (error) { return { outcome: 'crash', category: 'contract', reason: `IPC payload is not JSON serializable: ${String(error)}` }; }
  const problem = findNonJson(value) ?? (response.ok ? contracts.checkResult(command, value) : contracts.checkError(command, value));
  if (problem) return { outcome: 'crash', category: 'contract', reason: `response violates ${response.ok ? 'result' : 'error'} contract: ${problem}`, value };
  return { outcome: response.ok ? 'success' : 'business-error', value };
}

// C2 02:00Z conditional approval (C1 D-160 02:27Z): only restart_app's process relaunch.
// Rust's tauri restart has no error branch and needs a real GUI. dialog.open was
// removed once F4 9461780cd made pick_backup_directory return Ok(None) without a shell.
export const HEADLESS_BLOCKED_SHELL_OPS: ReadonlySet<string> = new Set(['plugin:process|restart']);

/** Reclassify only a panic caused by the smoke worker's deliberately absent shell,
 * and only when every shell request of that probe is one of the ops above. */
export function environmentBlocked(probe: { outcome: string; category?: string; reason?: string },
  shellRequests: readonly { op: string }[]) {
  if (probe.outcome !== 'crash' || probe.category !== 'panic' || shellRequests.length === 0) return undefined;
  if (!shellRequests.every(request => HEADLESS_BLOCKED_SHELL_OPS.has(request.op))) return undefined;
  if (!shellRequests.every(request => probe.reason?.includes(`smoke: shell unavailable (${request.op})`))) return undefined;
  return { outcome: 'environment-blocked', category: 'headless-shell', ops: shellRequests.map(request => request.op) };
}
