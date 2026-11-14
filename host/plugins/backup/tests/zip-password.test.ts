import { expect, it } from 'vitest';
import {
  resolveImportZipPassword, resolveZipEncryptionPassword, STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED,
} from '../src/zip-commands.ts';

const STORED = 'stored-passphrase';
const EXPLICIT = 'explicit-passphrase';

/** Rust `unwrap_err()` 后 `assert_eq!` 的等价：完整错误消息相等，而非 substring。 */
function exactError(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the action to throw');
}

it('flag_without_stored_password_is_fail_closed', () => {
  expect(exactError(() => resolveZipEncryptionPassword(null, true, null)))
    .toBe(STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED);
  expect(exactError(() => resolveZipEncryptionPassword('', true, '')))
    .toBe(STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED);
  expect(exactError(() => resolveZipEncryptionPassword('   ', true, ' \t')))
    .toBe(STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED);
  expect(STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED).toContain('E_STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED');
});

it('unconfigured_stays_portable', () => {
  expect(resolveZipEncryptionPassword(null, null, STORED)).toBeNull();
  expect(resolveZipEncryptionPassword(null, false, STORED)).toBeNull();
  expect(resolveZipEncryptionPassword(null, null, null)).toBeNull();
});

it('stored_password_used_when_flag_on', () => {
  expect(resolveZipEncryptionPassword(null, true, STORED)).toBe(STORED);
});

it('explicit_password_overrides_stored', () => {
  expect(resolveZipEncryptionPassword(EXPLICIT, true, STORED)).toBe(EXPLICIT);
});

it('empty_explicit_falls_back_to_stored', () => {
  expect(resolveZipEncryptionPassword('   ', true, STORED)).toBe(STORED);
});

it('portable_import_ignores_stored_password', () => {
  expect(resolveImportZipPassword(null, true, STORED, false)).toBeNull();
});

it('portable_import_keeps_explicit_password_for_existing_reject', () => {
  expect(resolveImportZipPassword('user-typed', true, STORED, false)).toBe('user-typed');
});

it('sealed_import_uses_stored_password', () => {
  expect(resolveImportZipPassword(null, true, STORED, true)).toBe(STORED);
});

it('sealed_import_without_stored_is_fail_closed', () => {
  expect(exactError(() => resolveImportZipPassword(null, true, null, true)))
    .toBe(STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED);
});

it('short_stored_password_is_fail_closed', () => {
  expect(() => resolveZipEncryptionPassword(null, true, 'short')).toThrow('E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT');
  expect(() => resolveZipEncryptionPassword(null, true, 'short')).toThrow('8');
});

it('short_explicit_password_is_fail_closed', () => {
  const message = exactError(() => resolveZipEncryptionPassword('short', true, STORED));
  expect(message).toContain('E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT');
  expect(message).toContain('8');
});

it('password_minimum_counts_unicode_code_points_and_keeps_stable_code', () => {
  expect(() => resolveZipEncryptionPassword('😀😀😀😀', true, STORED)).toThrow('E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT');
  expect(resolveZipEncryptionPassword('😀😀😀😀😀😀😀😀', true, STORED)).toBe('😀😀😀😀😀😀😀😀');
});

it('short_leftover_does_not_force_portable_when_flag_off', () => {
  expect(resolveZipEncryptionPassword(null, false, 'short')).toBeNull();
});

it('sealed_import_short_stored_passes_through_to_unseal', () => {
  expect(resolveImportZipPassword(null, true, 'short', true)).toBe('short');
});

it('sealed_import_short_explicit_passes_through_to_unseal', () => {
  expect(resolveImportZipPassword('short', true, STORED, true)).toBe('short');
});

it('portable_import_keeps_short_explicit_for_existing_reject', () => {
  expect(resolveImportZipPassword('short', true, STORED, false)).toBe('short');
});
