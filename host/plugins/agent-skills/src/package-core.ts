/**
 * Portable package heuristics shared by the desktop installer (`skill-package.ts`) and the
 * mobile host (`mobile.ts`): path guards, SKILL.md discovery, YAML list counting and the risk
 * grader. Pure string/byte work only — no `node:*`, no `Buffer`.
 *
 * `skill-package.ts` re-exports every function here, so the desktop API and its tests are
 * unchanged (`tests/package-core.test.ts` pins the parity of the two scanners).
 */
import { compareUtf8, decodeUtf8Lossy, utf8ByteLength } from '../../../platform/util/portable.ts';

export const MAX_SKILL_PACKAGE_ZIP_BYTES = 64 * 1024 * 1024;

/** `scan_skill_zip_bytes_with_limits` 的显式上限（skills.rs:1386）。 */
export interface ZipScanLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxEntryNameBytes: number;
}

export const DEFAULT_ZIP_SCAN_LIMITS: ZipScanLimits = {
  maxEntries: 2000,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntryNameBytes: 1024,
};

export interface SkillFileBytes {
  readonly relative: string;
  readonly bytes: Uint8Array;
}

export interface ZipScanOutcome {
  skillId: string;
  files: Array<[string, Uint8Array]>;
  packageSha256: string;
  riskLevel: string;
  riskSignals: string[];
}

export function isPortableSkillPathComponent(component: string): boolean {
  if (!component || component === '.' || component === '..') return false;
  if (utf8ByteLength(component) > 255 || component.length > 255) return false;
  if (component.endsWith(' ') || component.endsWith('.')) return false;
  if ([...component].some(ch => /[\u0000-\u001f\u007f-\u009f<>:"|?*]/.test(ch))) return false;
  const stem = (component.includes('.') ? component.slice(0, component.indexOf('.')) : component).toUpperCase();
  if (['CON', 'PRN', 'AUX', 'NUL'].includes(stem)) return false;
  return !(stem.length === 4 && (stem.startsWith('COM') || stem.startsWith('LPT')) && /^[1-9]$/.test(stem[3]!));
}

/** Port of skills.rs:874 `is_safe_zip_entry`. */
export function isSafeZipEntry(name: string): boolean {
  const normalized = name.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/')) return false;
  for (const part of normalized.split('/')) {
    if (!isPortableSkillPathComponent(part)) return false;
    if (['node_modules', '.git', 'target', 'dist', 'build'].includes(part.toLowerCase())) return false;
  }
  return true;
}

/** Port of skills.rs:920 `zip_skill_prefix`. */
export function zipSkillPrefix(entryNames: readonly string[]): [string, string] | null {
  for (const name of entryNames) {
    const norm = name.replaceAll('\\', '/');
    if (norm.toLowerCase() === 'skill.md') return ['', 'imported-skill'];
    const parts = norm.split('/');
    if (parts.length >= 2 && parts[parts.length - 1]!.toLowerCase() === 'skill.md'
      && parts.every(part => isPortableSkillPathComponent(part))) {
      const skillId = parts[parts.length - 2]!;
      const prefix = `${parts.slice(0, -1).join('/')}/`;
      return [prefix, skillId];
    }
  }
  return null;
}

/** Port of skills.rs:943 `root_skill_id_from_frontmatter`. */
export function rootSkillIdFromFrontmatter(files: readonly SkillFileBytes[]): string | null {
  const entry = files.find(file => file.relative === 'SKILL.md');
  if (!entry) return null;
  const content = decodeUtf8Lossy(entry.bytes);
  const lines = content.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
  if (lines[0]?.trim() !== '---') return null;
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (trimmed === '---') break;
    if (!trimmed.startsWith('name:')) continue;
    const skillId = trimmed.slice('name:'.length).trim().replace(/^["']+|["']+$/g, '');
    if (!skillId || utf8ByteLength(skillId) > 128 || !/^[A-Za-z0-9_-]+$/.test(skillId)
      || !isPortableSkillPathComponent(skillId)) return null;
    return skillId;
  }
  return null;
}

/** Port of skills.rs:975 `count_yaml_list_items`. */
export function countYamlListItems(content: string, key: string): number {
  let inBlock = false;
  let count = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}:`) || trimmed.startsWith(`${key} `)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (trimmed.startsWith('- ')) count++;
    else if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('-')) break;
  }
  return count;
}

const RISK_BINARY_EXTENSIONS = new Set([
  'exe', 'dll', 'so', 'dylib', 'node', 'bin', 'com', 'msi', 'scr', 'jar', 'wasm',
]);
const RISK_MEDIA_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg', 'pdf', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'wav', 'avif',
]);
const RISK_SCRIPT_EXTENSIONS = new Set(['ps1', 'sh', 'bat', 'cmd', 'py', 'js']);
const RISK_SHELL_KEYWORDS = ['shell', 'execute_command', 'local_shell'];
const RISK_NETWORK_KEYWORDS = ['fetch', 'curl', 'wget', 'http_request', 'web_search'];
const RISK_CREDENTIAL_KEYWORDS = ['token', 'secret', 'password', 'api_key', 'credential'];

/** skills.rs:1026 `PROMPT_INJECTION_PATTERNS` (same order, same semantics). */
const PROMPT_INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/i,
  /<\/system>/i,
  /<\|im_start\|>/i,
  /\[INST\]/i,
  /(?:without\s+(?:asking|confirmation|approval).{0,120}(?:shell|execute_command|local_shell|fetch|curl|wget|tool|command|http_request)|(?:shell|execute_command|local_shell|fetch|curl|wget|tool|command|http_request).{0,120}without\s+(?:asking|confirmation|approval))/i,
  /send\s+.+\s+to\s+https?:\/\//i,
  /curl\s+.+\$(?:\{)?[A-Za-z0-9_]*KEY/i,
  /do\s+not\s+(?:tell|inform|mention)\s+the\s+user/i,
  /(?:base64.{0,120}\b(?:execute|run|follow|obey|eval)\b|\b(?:execute|run|follow|obey|eval)\b.{0,120}base64)/is,
  /(?:^\s*(?:system|assistant)\s*:\s|["']role["']\s*:\s*["']system["']|\brole\s*:\s*system\b)/im,
  /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]*\?[^)\s]*=/i,
  /<\/?\s*(?:tool_call|tool_use|function_call)s?\s*>/i,
];

const LATIN_LOOKALIKES = (() => {
  const map = new Map<string, string>();
  const groups: Array<[string, string]> = [
    ['Аа', 'a'], ['Вв', 'b'], ['Сс', 'c'], ['ЕеЁё', 'e'], ['Нн', 'h'], ['ІіЇї', 'i'], ['Кк', 'k'],
    ['Мм', 'm'], ['Оо', 'o'], ['Рр', 'p'], ['Тт', 't'], ['Хх', 'x'], ['Уу', 'y'],
    ['Αα', 'a'], ['Ββ', 'b'], ['Εε', 'e'], ['Ηη', 'h'], ['Ιιίϊ', 'i'], ['Κκ', 'k'], ['Μμ', 'm'],
    ['Νν', 'n'], ['Οοό', 'o'], ['Ρρ', 'p'], ['Ττ', 't'], ['Υυ', 'y'], ['Χχ', 'x'],
  ];
  for (const [chars, replacement] of groups) for (const ch of chars) map.set(ch, replacement);
  return map;
})();

function foldLatinLookalike(ch: string): string {
  return LATIN_LOOKALIKES.get(ch) ?? ch;
}

const ZERO_WIDTH = new Set([
  '\u00ad', '\u034f', '\u061c', '\u180e', '\u200b', '\u200c', '\u200d', '\u200e', '\u200f',
  '\u2060', '\u2061', '\u2062', '\u2063', '\u2064', '\u2066', '\u2067', '\u2068', '\u2069', '\ufeff',
]);

/** Port of skills.rs:1131 `normalize_unicode_for_injection_scan`. */
export function normalizeUnicodeForInjectionScan(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ZERO_WIDTH.has(ch)) continue;
    const code = ch.codePointAt(0)!;
    out += foldLatinLookalike(code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : ch);
  }
  return out;
}

/** Port of skills.rs:1169 `count_prompt_injection_hits`. */
export function countPromptInjectionHits(text: string): number {
  const stripped = text.replace(/<!--.*?-->/gs, ' ');
  const unwrapped = text.replace(/<!--\s*(.*?)\s*-->/gs, ' $1 ');
  const candidates = [
    normalizeUnicodeForInjectionScan(text),
    normalizeUnicodeForInjectionScan(stripped),
    normalizeUnicodeForInjectionScan(unwrapped),
  ];
  return PROMPT_INJECTION_PATTERNS.filter(re => candidates.some(candidate => re.test(candidate))).length;
}

function riskFileExtension(normalizedLower: string): string {
  const fileName = normalizedLower.slice(normalizedLower.lastIndexOf('/') + 1);
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot + 1) : '';
}

/** Port of skills.rs:1209 `assess_skill_package_risk`. */
export function assessSkillPackageRisk(files: readonly SkillFileBytes[]): [string, string[]] {
  let shellTools = false;
  let networkTools = false;
  let executableScripts = false;
  let externalUrls = false;
  let credentialKeywords = false;
  let binaryFiles = false;
  let promptInjectionHits = 0;

  for (const file of files) {
    const norm = file.relative.replaceAll('\\', '/').toLowerCase();
    const ext = riskFileExtension(norm);
    if (RISK_BINARY_EXTENSIONS.has(ext)) {
      binaryFiles = true;
      continue;
    }
    if (file.bytes.includes(0)) {
      if (!RISK_MEDIA_EXTENSIONS.has(ext)) binaryFiles = true;
      continue;
    }
    if (norm.startsWith('scripts/') && RISK_SCRIPT_EXTENSIONS.has(ext)) executableScripts = true;

    const text = decodeUtf8Lossy(file.bytes).toLowerCase();
    if (text.includes('http://') || text.includes('https://')) externalUrls = true;
    if (RISK_CREDENTIAL_KEYWORDS.some(keyword => text.includes(keyword))) credentialKeywords = true;
    if (norm === 'skill.md') {
      if (RISK_SHELL_KEYWORDS.some(keyword => text.includes(keyword))) shellTools = true;
      if (RISK_NETWORK_KEYWORDS.some(keyword => text.includes(keyword))) networkTools = true;
    }
    if (norm === 'skill.md' || norm.endsWith('.md')) {
      promptInjectionHits += countPromptInjectionHits(decodeUtf8Lossy(file.bytes));
    }
  }

  const promptInjection = promptInjectionHits > 0;
  const signals: string[] = [];
  if (shellTools) signals.push('shell_tools');
  if (networkTools) signals.push('network_tools');
  if (executableScripts) signals.push('executable_scripts');
  if (externalUrls) signals.push('external_urls');
  if (credentialKeywords) signals.push('credential_keywords');
  if (binaryFiles) signals.push('binary_files');
  if (promptInjection) signals.push('prompt_injection');

  const level = binaryFiles
    || (credentialKeywords && (shellTools || networkTools || executableScripts))
    || (shellTools && networkTools)
    || (promptInjection && (promptInjectionHits >= 2 || shellTools))
    ? 'high'
    : shellTools || networkTools || executableScripts || externalUrls || credentialKeywords || promptInjection
      ? 'medium'
      : 'low';
  return [level, signals];
}

/** Stable UTF-8 byte order, like Rust `sort()` on `String`. */
export function sortUtf8(values: readonly string[]): string[] {
  return [...values].sort(compareUtf8);
}
