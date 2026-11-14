import { expect, it } from 'vitest';
import * as codes from '../src/restore-codes.ts';
import { atomicRestoreUnavailableError } from '../src/restore-commands.ts';
import { ATOMIC_RESTORE_UNAVAILABLE_CODE } from '../src/manifest.ts';

it('stable_code_literals_are_frozen', () => {
  expect(codes.RESTORE_DOMAIN_UNCONSUMED_CODE).toBe('E_RESTORE_DOMAIN_UNCONSUMED');
  expect(codes.RESTORE_DOMAIN_FAILED_CODE).toBe('E_RESTORE_DOMAIN_FAILED');
  expect(codes.RESTORE_UNTRUSTED_ISOLATED_CODE).toBe('E_RESTORE_UNTRUSTED_ISOLATED');
  expect(codes.RESTORE_ISOLATION_STATE_PENDING_TRUST).toBe('IsolatedPendingTrust');
  expect(codes.RESTORE_DETAILS_ISOLATION_STATE_FIELD).toBe('isolation_state');
  expect(codes.RESTORE_DETAILS_UNCONSUMED_DOMAINS_FIELD).toBe('unconsumed_domains');
  expect(codes.RESTORE_DETAILS_FAILED_DOMAINS_FIELD).toBe('failed_domains');
});

it('tagged_message_matches_bracket_prefix_convention', () => {
  const message = codes.taggedMessage(codes.RESTORE_DOMAIN_UNCONSUMED_CODE, 'crypto 域未被消费');
  expect(message).toBe('[E_RESTORE_DOMAIN_UNCONSUMED] crypto 域未被消费');
  expect(message).toContain(codes.RESTORE_DOMAIN_UNCONSUMED_CODE);
});

it('atomic_restore_unavailable_refusal_has_stable_code', () => {
  const error = atomicRestoreUnavailableError();
  expect(error).toContain(ATOMIC_RESTORE_UNAVAILABLE_CODE);
  expect(error).toContain('写入任何恢复数据前中止');
});

it('codes_are_distinct', () => {
  const values = [codes.RESTORE_DOMAIN_UNCONSUMED_CODE, codes.RESTORE_DOMAIN_FAILED_CODE, codes.RESTORE_UNTRUSTED_ISOLATED_CODE];
  for (let i = 0; i < values.length; i++) {
    for (const other of values.slice(i + 1)) expect(values[i]).not.toBe(other);
  }
});
