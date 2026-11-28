import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSecrets } from '../ci/release-contracts.mjs';

const BASE_REQUIRED = {
  TAURI_SIGNING_PRIVATE_KEY: 'minisign-key',
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'minisign-password',
  CLOUDFLARE_ACCOUNT_ID: 'cf-account',
  CLOUDFLARE_API_TOKEN: 'cf-token',
};

const APPLE_FULL = {
  APPLE_CERTIFICATE_BASE64: 'cDEy',
  APPLE_CERTIFICATE_PASSWORD: 'p12-password',
  APPLE_SIGNING_IDENTITY: 'Developer ID Application: Deep Student (TEAM123)',
  APPLE_ID: 'release@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
  APPLE_TEAM_ID: 'TEAM123',
};

const WINDOWS_FULL = {
  WINDOWS_CERTIFICATE_BASE64: 'cGZ4',
  WINDOWS_CERTIFICATE_PASSWORD: 'pfx-password',
};

test('checkSecrets automatically allows unsigned desktop builds when no OS certs are configured', () => {
  const policy = checkSecrets({ ...BASE_REQUIRED });
  assert.deepEqual(policy, {
    allowUnsignedMacos: true,
    allowUnsignedWindows: true,
    allowUnsignedDesktop: true,
  });
});

test('checkSecrets always fails closed when updater or Cloudflare secrets are missing', () => {
  assert.throws(
    () => checkSecrets({ ALLOW_UNSIGNED_DESKTOP: 'true', CLOUDFLARE_ACCOUNT_ID: 'cf-account' }),
    /TAURI_SIGNING_PRIVATE_KEY.*CLOUDFLARE_API_TOKEN/,
  );
});

test('checkSecrets fails closed on partial Apple signing configuration', () => {
  assert.throws(
    () => checkSecrets({ ...BASE_REQUIRED, APPLE_CERTIFICATE_BASE64: 'cDEy' }),
    /APPLE_CERTIFICATE_PASSWORD.*APPLE_TEAM_ID/,
  );
});

test('checkSecrets fails closed on partial Windows signing configuration', () => {
  assert.throws(
    () => checkSecrets({ ...BASE_REQUIRED, WINDOWS_CERTIFICATE_BASE64: 'cGZ4' }),
    /WINDOWS_CERTIFICATE_PASSWORD/,
  );
});

test('checkSecrets enables per-platform signing when only Apple certs are configured', () => {
  const policy = checkSecrets({ ...BASE_REQUIRED, ...APPLE_FULL });
  assert.deepEqual(policy, {
    allowUnsignedMacos: false,
    allowUnsignedWindows: true,
    allowUnsignedDesktop: true,
  });
});

test('checkSecrets enforces REQUIRE_SIGNED_DESKTOP=true unless ALLOW_UNSIGNED_DESKTOP=true overrides', () => {
  assert.throws(
    () => checkSecrets({ ...BASE_REQUIRED, REQUIRE_SIGNED_DESKTOP: 'true' }),
    /APPLE_CERTIFICATE_BASE64.*WINDOWS_CERTIFICATE_BASE64/,
  );

  const signed = checkSecrets({
    ...BASE_REQUIRED,
    ...APPLE_FULL,
    ...WINDOWS_FULL,
    REQUIRE_SIGNED_DESKTOP: 'true',
  });
  assert.deepEqual(signed, {
    allowUnsignedMacos: false,
    allowUnsignedWindows: false,
    allowUnsignedDesktop: false,
  });

  const forcedUnsigned = checkSecrets({
    ...BASE_REQUIRED,
    ...APPLE_FULL,
    ...WINDOWS_FULL,
    REQUIRE_SIGNED_DESKTOP: 'true',
    ALLOW_UNSIGNED_DESKTOP: 'true',
  });
  assert.deepEqual(forcedUnsigned, {
    allowUnsignedMacos: true,
    allowUnsignedWindows: true,
    allowUnsignedDesktop: true,
  });
});
