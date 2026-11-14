/**
 * 打包加固策略（`electron/scripts/app-hardening.cjs`）：打包配置（afterPack 翻转 fuses、mac 签名字段）与打包后校验
 * （`electron/scripts/verify-fuses.mjs`）共用同一份期望值。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, '..', '..');
const hardening = require('../scripts/app-hardening.cjs') as {
  expectedFuses(platform: string, options?: { signed?: boolean }): Record<string, boolean>;
  fuseConfig(platform: string, options?: { signed?: boolean }): Record<string | number, unknown>;
  isReleaseSigning(env: Record<string, string | undefined>): boolean;
  hasNotarizeCredentials(env: Record<string, string | undefined>): boolean;
  macSigning(env: Record<string, string | undefined>, projectDir: string): { signed: boolean; mac: Record<string, unknown> };
};
const { FuseV1Options, FuseVersion } = require('@electron/fuses') as { FuseV1Options: Record<string, number>; FuseVersion: Record<string, string> };
const plist = require('plist') as { parse(xml: string): Record<string, unknown> };

const COMMON = {
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  GrantFileProtocolExtraPrivileges: false,
};

describe('fuse policy', () => {
  it('disables the Node entry points and file:// extra privileges, and only runs the integrity-checked app.asar', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      for (const signed of [false, true]) expect(hardening.expectedFuses(platform, { signed })).toMatchObject(COMMON);
    }
    expect(() => hardening.expectedFuses('mas')).toThrow('unknown platform mas');
  });

  it('encrypts cookies on Windows and Linux always, on macOS only with a release signature (the keychain item follows the signature)', () => {
    expect(hardening.expectedFuses('win32')).toEqual({ ...COMMON, EnableCookieEncryption: true });
    expect(hardening.expectedFuses('linux')).toEqual({ ...COMMON, EnableCookieEncryption: true });
    expect(hardening.expectedFuses('darwin')).toEqual({ ...COMMON, EnableCookieEncryption: false });
    expect(hardening.expectedFuses('darwin', { signed: true })).toEqual({ ...COMMON, EnableCookieEncryption: true });
  });

  it('maps the policy onto an @electron/fuses config; macOS re-signs ad hoc right after flipping', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const expected = hardening.expectedFuses(platform);
      const config = hardening.fuseConfig(platform);
      expect(config.version).toBe(FuseVersion.V1);
      expect(config.resetAdHocDarwinSignature).toBe(platform === 'darwin');
      for (const [name, value] of Object.entries(expected)) expect(config[FuseV1Options[name]!], name).toBe(value);
      expect(Object.keys(config)).toHaveLength(Object.keys(expected).length + 2);
    }
    expect(hardening.fuseConfig('darwin', { signed: true })[FuseV1Options.EnableCookieEncryption!]).toBe(true);
  });
});

describe('macOS signing', () => {
  const entitlements = (file: unknown) => plist.parse(readFileSync(file as string, 'utf8'));

  it('defaults to ad hoc with hardened runtime, no timestamp server and no notarization; library validation is off as in the Tauri app', () => {
    const { signed, mac } = hardening.macSigning({}, repoRoot);
    expect(signed).toBe(false);
    expect(mac).toEqual({
      identity: '-', hardenedRuntime: true, timestamp: 'none', notarize: false,
      entitlements: join(repoRoot, 'electron', 'signing', 'entitlements.mac.adhoc.plist'),
      entitlementsInherit: join(repoRoot, 'electron', 'signing', 'entitlements.mac.adhoc.plist'),
    });
    const tauri = plist.parse(readFileSync(join(repoRoot, 'resources/app', 'Entitlements.plist'), 'utf8'));
    expect(entitlements(mac.entitlements)).toEqual({ 'com.apple.security.cs.allow-jit': true, ...tauri });
  });

  it('CSC_LINK / CSC_NAME switch to a release signature: Developer ID found by electron-builder, timestamped, notarized, library validation on', () => {
    for (const env of [{ CSC_LINK: '/secure/cert.p12' }, { CSC_NAME: 'Developer ID Application: Deep Student (TEAMID)' }]) {
      expect(hardening.isReleaseSigning(env)).toBe(true);
      const { signed, mac } = hardening.macSigning(env, repoRoot);
      expect(signed).toBe(true);
      expect(mac).toEqual({
        hardenedRuntime: true, notarize: true,
        entitlements: join(repoRoot, 'electron', 'signing', 'entitlements.mac.plist'),
        entitlementsInherit: join(repoRoot, 'electron', 'signing', 'entitlements.mac.plist'),
      });
      expect(entitlements(mac.entitlements)).toEqual({ 'com.apple.security.cs.allow-jit': true, 'com.apple.security.device.audio-input': true });
    }
    expect(hardening.isReleaseSigning({ CSC_LINK: '', CSC_NAME: '' })).toBe(false);
  });

  it('release builds need one complete set of notarization credentials', () => {
    expect(hardening.hasNotarizeCredentials({})).toBe(false);
    expect(hardening.hasNotarizeCredentials({ APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'p' })).toBe(false);
    expect(hardening.hasNotarizeCredentials({ APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'p', APPLE_TEAM_ID: 't' })).toBe(true);
    expect(hardening.hasNotarizeCredentials({ APPLE_API_KEY: 'k', APPLE_API_KEY_ID: 'i' })).toBe(false);
    expect(hardening.hasNotarizeCredentials({ APPLE_API_KEY: 'k', APPLE_API_KEY_ID: 'i', APPLE_API_ISSUER: 's' })).toBe(true);
    expect(hardening.hasNotarizeCredentials({ APPLE_KEYCHAIN_PROFILE: 'deep-student' })).toBe(true);
  });
});
