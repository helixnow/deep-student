/**
 * Portable half of the tap (skill source) flow: codeload URL resolution, repository zip
 * download, entry-name helpers and provenance codec. Shared by the desktop `skill-taps.ts`
 * (re-exported unchanged) and the mobile host, which uses the same URL/provenance rules but
 * reads zips through the async portable ZIP core.
 */
import type { HttpService } from '../../../platform/http/api.ts';
import { downloadHttpsBytes } from './http.ts';
import { extractFrontmatter } from './requires-core.ts';
import { MAX_SKILL_PACKAGE_ZIP_BYTES } from './package-core.ts';

export const CODELOAD_PREFIX = 'https://codeload.github.com/';

export function resolveCodeloadCandidates(repoUrl: string): string[] {
  const trimmed = repoUrl.trim().replace(/\/+$/, '');
  if (trimmed.startsWith(CODELOAD_PREFIX)) return [trimmed];
  const rest = trimmed.startsWith('https://github.com/')
    ? trimmed.slice('https://github.com/'.length)
    : trimmed.startsWith('https://www.github.com/')
      ? trimmed.slice('https://www.github.com/'.length)
      : null;
  if (rest === null) throw new Error('Only https://github.com/{owner}/{repo} tap sources are supported');
  const segments = rest.split('/').filter(segment => segment.length > 0);
  if (segments.length < 2) throw new Error('Repository URL must include owner and repo');
  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/, '');
  if (!owner || !repo) throw new Error('Repository URL must include owner and repo');
  if (segments.length >= 4 && segments[2] === 'tree') {
    return [`${CODELOAD_PREFIX}${owner}/${repo}/zip/${segments[3]!}`];
  }
  return [
    `${CODELOAD_PREFIX}${owner}/${repo}/zip/refs/heads/main`,
    `${CODELOAD_PREFIX}${owner}/${repo}/zip/refs/heads/master`,
  ];
}

export async function fetchRepoZip(candidates: readonly string[], http: HttpService): Promise<[Uint8Array, string]> {
  let lastError = 'No download candidates';
  for (const url of candidates) {
    try { return [await downloadHttpsBytes(url, MAX_SKILL_PACKAGE_ZIP_BYTES, http), url]; }
    catch (error) { lastError = `${url}: ${error instanceof Error ? error.message : String(error)}`; }
  }
  throw new Error(`Failed to download repository zip: ${lastError}`);
}

export function is_valid_skill_dir_name(name: string): boolean {
  return Boolean(name) && /^[\p{Alphabetic}\p{N}_-]+$/u.test(name);
}

export function repoZipTopPrefix(entryNames: readonly string[]): string | null {
  const first = entryNames[0];
  if (first === undefined) return null;
  const prefixEnd = first.indexOf('/');
  if (prefixEnd < 0) return null;
  const prefix = first.slice(0, prefixEnd + 1);
  return entryNames.every(name => name.startsWith(prefix)) ? prefix : null;
}

export function extractSkillSummary(content: string): [string, string, string] {
  const frontmatter = extractFrontmatter(content);
  if (frontmatter === null) return ['', '', ''];
  const get = (key: string): string => {
    for (const line of frontmatter.split('\n')) {
      if (!line.startsWith(key)) continue;
      const rest = line.slice(key.length);
      if (!rest.startsWith(':')) continue;
      const value = rest.slice(1).trim();
      if (!value || value === '|' || value === '>' || value === '>-' || value === '|-') continue;
      return value.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
    }
    return '';
  };
  return [get('name'), get('description'), get('version')];
}

export function repoNameFromZipUrl(zipUrl: string): string {
  const rest = zipUrl.startsWith(CODELOAD_PREFIX) ? zipUrl.slice(CODELOAD_PREFIX.length) : '';
  const parts = rest.split('/');
  const repo = parts[1] ?? '';
  const sanitized = [...repo].map(ch => /[\p{Alphabetic}\p{N}_-]/u.test(ch) ? ch : '-').join('');
  return sanitized || 'imported-skill';
}

export function encodeTapSourceDetail(zipUrl: string, subdir: string): string {
  return `${zipUrl}#${subdir}`;
}

export function decodeTapSourceDetail(detail: string): [string, string] {
  const hash = detail.lastIndexOf('#');
  if (hash < 0) throw new Error('Corrupted tap provenance detail (missing #subdir)');
  const url = detail.slice(0, hash);
  if (!url.startsWith('https://')) throw new Error('Corrupted tap provenance detail (invalid url)');
  return [url, detail.slice(hash + 1)];
}

const SPECIAL_SCHEMES = ['content://', 'asset://', 'ph://', 'image://', 'camera://'];

export function isSpecialScheme(value: string): boolean {
  const lower = value.trimStart().toLowerCase();
  return SPECIAL_SCHEMES.some(scheme => lower.startsWith(scheme));
}

export function isVirtualTapPath(value: string): boolean {
  const lower = value.trimStart().toLowerCase();
  return SPECIAL_SCHEMES.some(scheme => lower.startsWith(scheme))
    || ['primary:', 'secondary:', 'raw:'].some(prefix => lower.startsWith(prefix));
}

export const DOUBLE_ENCODED_VIRTUAL_URI_REJECTED =
  '路径像是双重编码的安全 URI，已拒绝以免破坏授权。请传入原始 content:// 地址';
