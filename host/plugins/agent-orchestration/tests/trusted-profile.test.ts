import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type TrustedAutomationProfile, computedProfileHash, sealTrustedProfile, validateTrustedProfile,
  TRUSTED_AUTOMATION_MAX_OUTPUT_BYTES, decodePersistedTrustedProfile, serializeTrustedProfile,
} from '../src/trusted-profile.ts';
import { rowToAutomation } from '../repository/automations.ts';

function profile(): TrustedAutomationProfile {
  const value: TrustedAutomationProfile = {
    schemaVersion: 1,
    profileHash: '',
    allowedTools: ['builtin-local_shell_execute'],
    runtimeRoots: [{ rootId: 'workspace', access: 'read_write' }],
    shellCommandPrefixes: ['unzip'],
    networkDomains: ['example.com'],
    maxToolRounds: 8,
    timeoutSeconds: 300,
    maxOutputBytes: 64 * 1024,
    rollbackRequired: true,
  };
  value.profileHash = computedProfileHash(value);
  return value;
}

describe('automations.rs trusted automation profile', () => {
  it('aut_01_legacy_definition_defaults_to_no_trusted_profile', () => {
    const row = rowToAutomation({
      id: 'auto_1', name: 'old', schedule_json: '{"kind":"daily","time":"09:00"}',
      prompt: 'p', enabled: 1, created_at: '2026-01-01T00:00:00+00:00',
      updated_at: '2026-01-01T00:00:00+00:00', source_session_id: 'sess_x',
      action_type: 'notify', heartbeat: 0, catch_up_policy: 'run_once',
      max_retries: 2, retry_backoff_seconds: 60, timeout_seconds: 600, version: 1,
    });
    expect(row.trusted_profile).toBeNull();
  });

  it('aut_02_profile_hash_is_content_locked', () => {
    const unsealed = profile();
    unsealed.profileHash = '';
    const sealed = sealTrustedProfile(unsealed);
    expect(sealed.profileHash).toBe(computedProfileHash(sealed));

    const value = profile();
    expect(() => validateTrustedProfile(value)).not.toThrow();
    value.maxToolRounds += 1;
    expect(() => validateTrustedProfile(value)).toThrow('hash does not match');
  });

  it('aut_03_profile_rejects_untrusted_tools_and_unsafe_prefixes', () => {
    const untrusted = profile();
    untrusted.allowedTools = ['builtin-tool_pack'];
    untrusted.profileHash = computedProfileHash(untrusted);
    expect(() => validateTrustedProfile(untrusted)).toThrow('not eligible');

    const unsafe = profile();
    unsafe.shellCommandPrefixes = ['unzip; rm'];
    unsafe.profileHash = computedProfileHash(unsafe);
    expect(() => validateTrustedProfile(unsafe)).toThrow('Unsafe shell command prefix');
  });

  it('aut_04_profile_rejects_rw_authorized_root_and_missing_rollback', () => {
    const authorized = profile();
    authorized.runtimeRoots = [{ rootId: 'authorized_abc', access: 'read_write' }];
    authorized.profileHash = computedProfileHash(authorized);
    expect(() => validateTrustedProfile(authorized)).toThrow('authorized runtime roots are always read-only');

    const noRollback = profile();
    noRollback.rollbackRequired = false;
    noRollback.profileHash = computedProfileHash(noRollback);
    expect(() => validateTrustedProfile(noRollback)).toThrow('rollback_required=true');
  });

  it('aut_05_profile_enforces_budget_caps', () => {
    const value = profile();
    value.maxToolRounds = 31;
    value.maxOutputBytes = TRUSTED_AUTOMATION_MAX_OUTPUT_BYTES + 1;
    value.profileHash = computedProfileHash(value);
    expect(() => validateTrustedProfile(value)).toThrow();
  });
});

describe('trusted profile u64 fidelity along hash/seal (automations.rs:321-328, 442-451)', () => {
  it('hashes the exact serde bytes of a decoded u64 above 2^53 and reaches the range check, not the hash check', () => {
    const base = profile();
    const compact = (hash: string) => `{"schemaVersion":1,"profileHash":"${hash}","allowedTools":["builtin-local_shell_execute"],`
      + '"runtimeRoots":[{"rootId":"workspace","access":"read_write"}],"shellCommandPrefixes":["unzip"],'
      + '"networkDomains":["example.com"],"maxToolRounds":8,"timeoutSeconds":9007199254740993,'
      + `"maxOutputBytes":${base.maxOutputBytes},"rollbackRequired":true}`;
    const expected = createHash('sha256').update(compact(''), 'utf8').digest('hex');
    const decoded = decodePersistedTrustedProfile(compact(expected));
    expect(decoded.timeoutSeconds).toBe(9007199254740993n);
    expect(serializeTrustedProfile(decoded)).toBe(compact(expected));
    expect(computedProfileHash(decoded)).toBe(expected);
    // Rust validate(): hash check precedes the timeout range check.
    expect(() => validateTrustedProfile(decoded)).toThrow('profile timeout_seconds must be between 30 and 3600');
    expect(() => sealTrustedProfile(decoded)).toThrow('profile timeout_seconds must be between 30 and 3600');
  });
});
