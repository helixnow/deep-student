import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildInfo, bundledSentryDsn, sentryRelease, writeBundledSentryDsn } from '../build-info.ts';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bundled(content: string | Uint8Array): () => ReturnType<typeof buildInfo> {
  const root = mkdtempSync(join(tmpdir(), 'f2-build-info-'));
  roots.push(root);
  mkdirSync(join(root, 'electron', '.build'), { recursive: true });
  writeFileSync(join(root, 'electron', '.build', 'version.json'), content);
  return () => buildInfo(root, '0.11.0');
}
const json = (value: unknown) => bundled(JSON.stringify(value));

it('bundled version.json is accepted only with what build.rs would embed', () => {
  expect(json({ version: '0.11.0', buildNumber: 14639, gitHash: 'abcdef01' })()).toEqual({ version: '0.11.0', buildNumber: 14639, gitHash: 'abcdef01', gitRevision: 'unknown' });
  expect(json({ version: '0.11.0', buildNumber: 2_100_000_000, gitHash: 'unknown' })().buildNumber).toBe(2_100_000_000);
  expect(json({ version: '0.11.0', buildNumber: 14638, gitHash: 'abcdef01' })).toThrow('build number must be greater than 14638 and at most 2100000000, got 14638');
  expect(json({ version: '0.11.0', buildNumber: 2_100_000_001, gitHash: 'abcdef01' })).toThrow('got 2100000001');
  expect(json({ version: '0.11.0', buildNumber: 14700.5, gitHash: 'abcdef01' })).toThrow('build number must be');
  expect(json({ version: '0.11.0', buildNumber: '14700', gitHash: 'abcdef01' })).toThrow('buildNumber must be a number');
  expect(json({ version: '0.10.0', buildNumber: 14700, gitHash: 'abcdef01' })).toThrow('version must equal the application version');
  expect(json({ version: '0.11.0', buildNumber: 14700, gitHash: 'ABCDEF01' })).toThrow('gitHash must be 8 lowercase hex digits');
  expect(json([])).toThrow('expected an object');
  expect(bundled(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('{}')]))).toThrow('invalid');
});

const REVISION = 'abcdef0123456789abcdef0123456789abcdef01';

it('the full commit in version.json must be the one gitHash abbreviates (build.rs derives GIT_HASH from it)', () => {
  expect(json({ version: '0.11.0', buildNumber: 14639, gitHash: 'abcdef01', gitRevision: REVISION })().gitRevision).toBe(REVISION);
  expect(json({ version: '0.11.0', buildNumber: 14639, gitHash: 'unknown', gitRevision: 'unknown' })().gitRevision).toBe('unknown');
  expect(json({ version: '0.11.0', buildNumber: 14639, gitHash: '12345678', gitRevision: REVISION })).toThrow('is not the prefix of gitRevision');
  expect(json({ version: '0.11.0', buildNumber: 14639, gitHash: 'abcdef01', gitRevision: REVISION.toUpperCase() })).toThrow('gitRevision must be a full lowercase commit ID');
  expect(json({ version: '0.11.0', buildNumber: 14639, gitHash: 'abcdef01', gitRevision: 'abcdef01' })).toThrow('gitRevision must be');
});

it('the Sentry release is build.rs SENTRY_RELEASE, the same string generate-version.mjs gives the frontend', async () => {
  const { formatSentryRelease } = await import(new URL('../../scripts/generate-version.mjs', import.meta.url).href) as {
    formatSentryRelease(version: string, build: number, revision: string): string;
  };
  for (const info of [
    { version: '0.11.0', buildNumber: 14639, gitHash: 'abcdef01', gitRevision: REVISION },
    { version: '0.11.0', buildNumber: 20000, gitHash: 'unknown', gitRevision: 'unknown' },
  ]) {
    expect(sentryRelease(info)).toBe(formatSentryRelease(info.version, info.buildNumber, info.gitRevision));
  }
  expect(sentryRelease({ version: '0.11.0', buildNumber: 14639, gitHash: 'abcdef01', gitRevision: REVISION })).toBe(`0.11.0+14639.${REVISION}`);
});

it('a git checkout without version.json reports the full lowercase HEAD as gitRevision, "unknown" outside git', () => {
  vi.stubEnv('DEEP_STUDENT_BUILD_NUMBER', '20000');
  try {
    const root = mkdtempSync(join(tmpdir(), 'f2-build-info-'));
    roots.push(root);
    expect(buildInfo(root, '0.11.0')).toEqual({ version: '0.11.0', buildNumber: 20000, gitHash: 'unknown', gitRevision: 'unknown' });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'x');
    const head = git('rev-parse', 'HEAD');
    expect(buildInfo(root, '0.11.0')).toEqual({ version: '0.11.0', buildNumber: 20000, gitHash: head.slice(0, 8), gitRevision: head });
  } finally {
    vi.unstubAllEnvs();
  }
});

it('the packaging step embeds SENTRY_DSN only when it is set and removes a DSN left by an earlier run', () => {
  const root = mkdtempSync(join(tmpdir(), 'f2-build-info-'));
  roots.push(root);
  const dsn = 'https://public@o0.ingest.example.invalid/1';
  expect(bundledSentryDsn(root)).toBeUndefined();
  expect(writeBundledSentryDsn(root, { SENTRY_DSN: dsn })).toBe(true);
  expect(bundledSentryDsn(root)).toBe(dsn);
  expect(writeBundledSentryDsn(root, { SENTRY_DSN: '  ' })).toBe(false);
  expect(bundledSentryDsn(root)).toBeUndefined();
  expect(writeBundledSentryDsn(root, { SENTRY_DSN: dsn })).toBe(true);
  expect(writeBundledSentryDsn(root, {})).toBe(false);
  expect(bundledSentryDsn(root)).toBeUndefined();
  mkdirSync(join(root, 'electron', '.build'), { recursive: true });
  writeFileSync(join(root, 'electron', '.build', 'backend-sentry.json'), '{"dsn": 42}');
  expect(bundledSentryDsn(root)).toBeUndefined();
});
