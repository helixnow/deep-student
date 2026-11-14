// dstu-sync/src/data_governance/restore_codes.rs:19-58.
export const RESTORE_DOMAIN_UNCONSUMED_CODE = 'E_RESTORE_DOMAIN_UNCONSUMED';
export const RESTORE_DOMAIN_FAILED_CODE = 'E_RESTORE_DOMAIN_FAILED';
export const RESTORE_UNTRUSTED_ISOLATED_CODE = 'E_RESTORE_UNTRUSTED_ISOLATED';
export const RESTORE_ISOLATION_STATE_PENDING_TRUST = 'IsolatedPendingTrust';
export const RESTORE_DETAILS_ISOLATION_STATE_FIELD = 'isolation_state';
export const RESTORE_DETAILS_UNCONSUMED_DOMAINS_FIELD = 'unconsumed_domains';
export const RESTORE_DETAILS_FAILED_DOMAINS_FIELD = 'failed_domains';

export function taggedMessage(code: string, detail: string): string {
  return `[${code}] ${detail}`;
}
