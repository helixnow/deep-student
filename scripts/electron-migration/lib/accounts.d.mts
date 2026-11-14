export interface AccountsConfig {
  integration: string;
  accounts: string[];
  cooldownMinutes?: number;
  quotaWindowMinutes?: number;
}
export interface AccountsState {
  active: string;
  exhausted: Record<string, string>;
  lastSwitchAt: string | null;
  index?: number;
}
/** action=switch 时有 to；action=stay 时有 reason，全部耗尽时还有 nextAvailableAt。 */
export interface Decision {
  action: "switch" | "stay";
  to?: string;
  reason?: string;
  nextAvailableAt?: number;
}
export const QUOTA_RE: RegExp;
export function isQuotaError(error: unknown): boolean;
export function normalizeState(state: Partial<AccountsState> | null | undefined, cfg: AccountsConfig): AccountsState;
export function availableAt(state: AccountsState, cfg: AccountsConfig, account: string): number;
export function pickAvailable(state: AccountsState, cfg: AccountsConfig, nowMs: number): string | null;
export function decide(state: AccountsState, cfg: AccountsConfig, nowMs: number, event: { quotaHit: boolean }): Decision;
export function commitSwitch(state: AccountsState, to: string, nowMs: number): void;
