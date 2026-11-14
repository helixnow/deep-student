import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { isContentUri, parseExternalOpenMode, purgeExpiredSharedCopies, resolveShareableSource, stageForSharing } from '../external-file.ts';
import { macosSettingsPlatform, parseMacosMajorVersion, parsePermissionTarget, settingsUri } from '../system-permissions.ts';

const roots: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'f2-platform-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('mode_parse_defaults_to_view_and_rejects_unknown', () => {
  expect(parseExternalOpenMode(null)).toBe('view');
  expect(parseExternalOpenMode('')).toBe('view');
  expect(parseExternalOpenMode('share')).toBe('share');
  expect(() => parseExternalOpenMode('reveal')).toThrow();
});
it('content_uri_detection_is_case_insensitive', () => {
  expect(isContentUri('content://com.android.providers/document/1')).toBe(true);
  expect(isContentUri('  CONTENT://x/y')).toBe(true);
  for (const p of ['/data/user/0/app/files/a.pdf', 'file:///sdcard/a.pdf', 'content:']) expect(isContentUri(p)).toBe(false);
});
it('source_must_be_a_file_inside_an_allowed_root', () => {
  const app = temp(), outside = temp();
  mkdirSync(join(app, 'workspace'));
  const inside = join(app, 'workspace/report.pdf'), secret = join(outside, 'secret.txt');
  writeFileSync(inside, 'pdf'); writeFileSync(secret, 'x');
  expect(resolveShareableSource(inside, [app])).toBe(realpathSync(inside));
  for (const p of [secret, join(app, 'workspace'), join(app, 'missing.pdf'), `${app}/workspace/../../${basename(outside)}/secret.txt`]) {
    expect(() => resolveShareableSource(p, [app])).toThrow();
  }
});
it('staging_copies_into_shared_subdir_and_reuses_shared_files', () => {
  const cache = temp(), data = temp(), source = join(data, '讲义 第1章.pptx');
  writeFileSync(source, 'pptx-bytes');
  const staged = stageForSharing(cache, source, () => undefined);
  expect(staged.startsWith(realpathSync(join(cache, 'shared')) + sep)).toBe(true);
  expect(basename(staged)).toBe('讲义 第1章.pptx');
  expect(readFileSync(staged)).toEqual(Buffer.from('pptx-bytes'));
  expect(existsSync(source)).toBe(true);
  expect(stageForSharing(cache, staged, () => undefined)).toBe(staged);
});
it('purge_removes_only_expired_entries', () => {
  const shared = temp(), fresh = join(shared, 'fresh'); mkdirSync(fresh);
  purgeExpiredSharedCopies(shared, 86_400_000, () => undefined); expect(existsSync(fresh)).toBe(true);
  purgeExpiredSharedCopies(shared, 0, () => undefined); expect(existsSync(fresh)).toBe(false);
});
it('maps_modern_macos_targets_to_fixed_system_settings_urls', () => {
  expect(settingsUri('macos-modern', 'notifications')).toBe('x-apple.systempreferences:com.apple.Notifications-Settings.extension');
  expect(settingsUri('macos-modern', 'microphone')).toBe('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone');
});
it('maps_legacy_macos_targets_to_fixed_system_preferences_urls', () => {
  expect(settingsUri('macos-legacy', 'notifications')).toBe('x-apple.systempreferences:com.apple.preference.notifications');
  expect(settingsUri('macos-legacy', 'microphone')).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
});
it('selects_legacy_urls_only_before_macos_ventura', () => {
  expect(macosSettingsPlatform(12)).toBe('macos-legacy');
  expect(macosSettingsPlatform(13)).toBe('macos-modern');
  expect(macosSettingsPlatform(null)).toBe('macos-modern');
});
it('parses_macos_compatibility_versions', () => {
  for (const [raw, major] of [['12.7.6\n', 12], ['13.0', 13], ['26.0.1', 26], ['unknown', null]] as const) {
    expect(parseMacosMajorVersion(Buffer.from(raw))).toBe(major);
  }
  expect(parseMacosMajorVersion(Uint8Array.of(255))).toBe(null);
});
it('maps_windows_targets_to_fixed_settings_uris', () => {
  expect(settingsUri('windows', 'notifications')).toBe('ms-settings:notifications');
  expect(settingsUri('windows', 'microphone')).toBe('ms-settings:privacy-microphone');
});
it('rejects_unknown_permission_targets', () => {
  expect(() => parsePermissionTarget(JSON.parse('"full_disk_access"'))).toThrow();
});
