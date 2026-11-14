import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import packageJson from '../package.json' with { type: 'json' };

export interface BuildInfo { version: string; buildNumber: number; gitHash: string; gitRevision: string }

/** 仓库根目录；打包后是 app.asar 的根。 */
export const APP_ROOT = resolve(import.meta.dirname, '..');

export function appBuildInfo(): BuildInfo {
  return buildInfo(APP_ROOT, packageJson.version);
}

/** commands.rs:500-507: build metadata, independent of an AppHandle or Shell bridge. */
export function getAppVersion(info: BuildInfo = appBuildInfo()): string {
  return `${info.version} (Build ${info.buildNumber}, ${info.gitHash})`;
}

/** build.rs:45 `SENTRY_RELEASE`, the same string scripts/generate-version.mjs `formatSentryRelease` gives the frontend. */
export function sentryRelease(info: BuildInfo): string {
  return `${info.version}+${info.buildNumber}.${info.gitRevision}`;
}

/** Same baseline, override and validation as src-tauri/build.rs:10-12,62-99,142-173. */
export function buildInfo(root: string, version: string): BuildInfo {
  const bundled = join(root, 'electron', '.build', 'version.json');
  if (existsSync(bundled)) return decodeBundledBuildInfo(readFileSync(bundled), version, bundled);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const baseline = '64edcb7735e5d4e6ccad6f13514b9ee0a8867c78';
  const override = process.env.DEEP_STUDENT_BUILD_NUMBER;
  let buildNumber: number;
  if (override !== undefined) {
    if (!/^\d+$/.test(override)) throw new Error('DEEP_STUDENT_BUILD_NUMBER must be valid UTF-8 decimal digits');
    buildNumber = Number(override);
  } else {
    git('cat-file', '-e', `${baseline}^{commit}`);
    git('merge-base', '--is-ancestor', baseline, 'HEAD');
    buildNumber = 14638 + Number(git('rev-list', '--count', `${baseline}..HEAD`));
  }
  checkBuildNumber(buildNumber);
  let gitRevision: string;
  try {
    // resolve_git_revision: only a 40/64-hex commit ID counts, lowercased; anything else is "unknown".
    const revision = git('rev-parse', 'HEAD');
    gitRevision = FULL_REVISION.test(revision.toLowerCase()) ? revision.toLowerCase() : 'unknown';
  } catch { gitRevision = 'unknown'; }
  return { version, buildNumber, gitHash: shortHash(gitRevision), gitRevision };
}

const FULL_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const shortHash = (revision: string) => (revision === 'unknown' ? revision : revision.slice(0, 8));

function checkBuildNumber(buildNumber: number): void {
  if (!Number.isInteger(buildNumber) || buildNumber <= 14638 || buildNumber > 2_100_000_000) throw new Error(`build number must be greater than 14638 and at most 2100000000, got ${buildNumber}`);
}

/**
 * `electron/.build/version.json` is written by scripts/package.mjs, but is still input: it must carry
 * what build.rs would have embedded (same version, BUILD_NUMBER range, GIT_HASH form). `gitRevision`
 * (the full commit in SENTRY_RELEASE) is absent from files written before it existed and reads as "unknown".
 */
function decodeBundledBuildInfo(bytes: Uint8Array, version: string, path: string): BuildInfo {
  const fail = (detail: string): never => { throw new Error(`invalid ${path}: ${detail}`); };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('expected an object');
  const info = value as Record<string, unknown>;
  if (info.version !== version) return fail(`version must equal the application version ${JSON.stringify(version)}, got ${JSON.stringify(info.version)}`);
  if (typeof info.buildNumber !== 'number') return fail('buildNumber must be a number');
  checkBuildNumber(info.buildNumber);
  if (typeof info.gitHash !== 'string' || !/^(?:[0-9a-f]{8}|unknown)$/.test(info.gitHash)) return fail(`gitHash must be 8 lowercase hex digits or "unknown", got ${JSON.stringify(info.gitHash)}`);
  const gitRevision = info.gitRevision ?? 'unknown';
  if (typeof gitRevision !== 'string' || (gitRevision !== 'unknown' && !FULL_REVISION.test(gitRevision))) return fail(`gitRevision must be a full lowercase commit ID or "unknown", got ${JSON.stringify(info.gitRevision)}`);
  if (gitRevision !== 'unknown' && shortHash(gitRevision) !== info.gitHash) return fail(`gitHash ${JSON.stringify(info.gitHash)} is not the prefix of gitRevision ${JSON.stringify(gitRevision)}`);
  return { version, buildNumber: info.buildNumber, gitHash: info.gitHash, gitRevision };
}

const bundledSentryFile = (root: string) => join(root, 'electron', '.build', 'backend-sentry.json');

/**
 * Rust `option_env!("SENTRY_DSN")`: the DSN CI had when the binary was built. scripts/package.mjs writes it with
 * {@link writeBundledSentryDsn}; there is no such file otherwise.
 */
export function bundledSentryDsn(root: string = APP_ROOT): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(bundledSentryFile(root), 'utf8'));
  } catch {
    return undefined;
  }
  const dsn = (value as { dsn?: unknown } | null)?.dsn;
  return typeof dsn === 'string' ? dsn : undefined;
}

/**
 * Packaging step: embed `SENTRY_DSN` (CI injects it from secrets) when it is set, otherwise remove a file left by an
 * earlier packaging run so a local build never ships someone else's DSN. Returns whether a DSN was embedded; callers
 * must not print the value.
 */
export function writeBundledSentryDsn(root: string, env: Readonly<Record<string, string | undefined>>): boolean {
  const target = bundledSentryFile(root);
  const dsn = env.SENTRY_DSN;
  if (dsn === undefined || dsn.trim() === '') {
    rmSync(target, { force: true });
    return false;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ dsn })}\n`);
  return true;
}
