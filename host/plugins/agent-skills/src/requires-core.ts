/**
 * Portable half of `requires.ts`: frontmatter extraction and the `requires` declaration
 * parser are pure string functions, so the mobile host (`mobile.ts`) needs them without
 * `node:child_process` / `node:fs`. `requires.ts` re-exports every function here, keeping
 * the desktop probing API unchanged (`tests/requires.test.ts` protects the behaviour).
 */
import type { SkillRequires, SkillRequiresProbe } from '../api.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';

// `platform/util/index.ts` is the desktop entry (node-free for text helpers); importing
// the functions directly keeps this module free of the rest of that barrel.
import { rustTrim as trim, rustTrimStart as trimStart } from '../../../platform/util/text.ts';

const unquote = (s: string) => s.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
const lines = (s: string) => s.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
const delimiter = (s: string) => s.replace(/[\r\n]+$/g, '').replace(/[ \t]+$/g, '') === '---';
const empty = (): SkillRequires => ({ bins: [], env: [], python_packages: [] });

export function extractFrontmatter(text: string): string | null {
  const value = trimStart(text);
  const openingEnd = value.indexOf('\n');
  if (openingEnd < 0 || !delimiter(value.slice(0, openingEnd + 1))) return null;
  const bodyStart = openingEnd + 1;
  let offset = bodyStart;
  for (const line of value.slice(bodyStart).match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (delimiter(line)) return trim(value.slice(bodyStart, offset));
    offset += line.length;
  }
  return null;
}

function parseInlineArray(raw: string): string[] {
  return trim(raw).replace(/^\[+|\]+$/g, '').split(',').map(part => unquote(trim(part))).filter(Boolean);
}

function parseMappingValue(block: string, key: string, baseIndent = 0): string | null {
  const prefix = `${key}:`;
  const source = lines(block);
  let blockStart = -1;
  let blockIndent = 0;
  for (const [index, line] of source.entries()) {
    if (!trim(line) || trimStart(line).startsWith('#')) continue;
    const indent = utf8ByteLength(line) - utf8ByteLength(trimStart(line));
    if (indent < baseIndent) break;
    const value = trim(line);
    if (blockStart < 0) {
      if (indent === baseIndent && (value === prefix || value.startsWith(`${prefix} `))) {
        const rest = trim(value.slice(prefix.length));
        if (rest) return unquote(rest);
        blockIndent = indent + 2;
        blockStart = index + 1;
      }
    } else if (indent <= baseIndent) break;
  }
  if (blockStart < 0) return null;
  const collected: string[] = [];
  for (const line of source.slice(blockStart)) {
    if (!trim(line) || trimStart(line).startsWith('#')) continue;
    const indent = utf8ByteLength(line) - utf8ByteLength(trimStart(line));
    if (indent < blockIndent) break;
    // `blockIndent` counts bytes; continuation lines start at a byte boundary because the
    // skipped prefix is ASCII whitespace (one byte per character).
    collected.push(line.slice(blockIndent));
  }
  return collected.join('\n');
}

function parseInlineMappingList(mapping: string, key: string): string[] | null {
  const value = trim(mapping);
  if (!value.startsWith('{') || !value.endsWith('}')) return null;
  const inner = value.slice(1, -1);
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  const fields: string[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote !== null) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) { fields.push(inner.slice(start, i)); start = i + 1; }
  }
  fields.push(inner.slice(start));
  for (const field of fields) {
    const colon = field.indexOf(':');
    if (colon < 0) continue;
    if (trim(field.slice(0, colon)).replace(/^["']+|["']+$/g, '') === key) return parseInlineArray(trim(field.slice(colon + 1)));
  }
  return null;
}

function parseListField(block: string, key: string): string[] {
  const prefix = `${key}:`;
  const items: string[] = [];
  let collecting = false;
  let keyIndent = 0;
  for (const line of lines(block)) {
    if (!trim(line) || trimStart(line).startsWith('#')) continue;
    const indent = utf8ByteLength(line) - utf8ByteLength(trimStart(line));
    const value = trim(line);
    if (value === prefix || value.startsWith(`${prefix} `)) {
      const rest = trim(value.slice(prefix.length));
      if (rest.startsWith('[')) return parseInlineArray(rest);
      collecting = true;
      keyIndent = indent;
      continue;
    }
    if (collecting) {
      if (value.startsWith('- ') && indent > keyIndent) {
        const item = unquote(trim(value.slice(2)));
        if (item) items.push(item);
        continue;
      }
      if (indent <= keyIndent && value.includes(':')) break;
    }
  }
  return items;
}

export function parseRequires(text: string): SkillRequires {
  const frontmatter = extractFrontmatter(text);
  const result = empty();
  if (frontmatter === null) return result;
  const merge = (block: string) => {
    const requires = parseMappingValue(block, 'requires');
    if (requires === null) return;
    for (const key of ['bins', 'env', 'python_packages'] as const) {
      for (const item of parseInlineMappingList(requires, key) ?? parseListField(requires, key)) {
        if (!result[key].includes(item)) result[key].push(item);
      }
    }
  };
  merge(frontmatter);
  const metadata = parseMappingValue(frontmatter, 'metadata');
  const openclaw = metadata === null ? null : parseMappingValue(metadata, 'openclaw');
  if (openclaw !== null) merge(openclaw);
  return result;
}

const asciiLower = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase());

export function pythonImportName(name: string): string {
  const lower = asciiLower(name).replaceAll('_', '-');
  const mappings: Record<string, string> = {
    pymupdf: 'fitz', pillow: 'PIL', 'opencv-python': 'cv2', 'opencv-python-headless': 'cv2',
    'scikit-learn': 'sklearn', beautifulsoup4: 'bs4', bs4: 'bs4', pyyaml: 'yaml',
    'python-dateutil': 'dateutil', 'msgpack-python': 'msgpack',
  };
  return Object.hasOwn(mappings, lower) ? mappings[lower]! : lower.replaceAll('-', '_');
}

export function partitionRequires(requires: SkillRequires): [SkillRequires, string[]] {
  const valid = empty();
  const invalid: string[] = [];
  const validators = {
    bins: /^[A-Za-z0-9._+-]{1,64}$/, env: /^[A-Za-z_][A-Za-z0-9_]{0,127}$/,
    python_packages: /^[A-Za-z0-9]([A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/,
  };
  const prefixes = { bins: 'bin', env: 'env', python_packages: 'python_package' };
  for (const key of ['bins', 'env', 'python_packages'] as const) {
    for (const name of requires[key]) {
      // JS $ also matches before a trailing newline; Rust's $ here is end-of-input.
      if (!name.includes('\n') && validators[key].test(name)) valid[key].push(name);
      else invalid.push(`${prefixes[key]}:${name}`);
    }
  }
  return [valid, invalid];
}

export function invalidRequiresSorted(invalid: readonly string[]): string[] {
  return [...new Set(invalid)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function emptyRequiresProbe(): SkillRequiresProbe {
  return { bins: [], env: [], python_packages: [], invalid: [], missing_count: 0 };
}
