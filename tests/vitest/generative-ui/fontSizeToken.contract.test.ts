/**
 * Contract: generative-ui 组件 / CSS 不得含裸 px 字号。
 * 字号必须走宪法三级 token：text-xs / text-sm / text-base（及 text-lg / text-caption）。
 *
 * 允许：间距 token 的 4/8/12px CSS 变量（--generative-ui-space-*）。
 * 豁免：注释、few-shot 负例、测试文件。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();
const SCAN_ROOTS = [
  path.join(REPO, 'src/features/generative-ui/components'),
  path.join(REPO, 'src/features/generative-ui/generative-ui.css'),
] as const;

const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.css']);

const ALLOWED_SPACE_PX = new Set([4, 8, 12]);

/** Tailwind 任意值字号：text-[13px] / sm:text-[0.8rem] / text-[length:14px] */
const TAILWIND_ARBITRARY_FONT_SIZE =
  /(?:^|[^a-zA-Z0-9_-])((?:[\w-]+:)*text-\[(?:length:)?\d+(?:\.\d+)?(?:px|rem|em|pt)\])/g;

/** CSS 声明：font-size: 14px */
const CSS_FONT_SIZE = /font-size\s*:\s*\d+(?:\.\d+)?(?:px|rem|em|pt)\b/gi;

/** JS/TS：fontSize: 14 或 fontSize: '14px' */
const JS_FONT_SIZE_NUMBER = /fontSize\s*:\s*\d+(?:\.\d+)?(?!\s*(?:px|rem|em|pt)\b)/g;
const JS_FONT_SIZE_STRING = /fontSize\s*:\s*(['"`])\d+(?:\.\d+)?(?:px|rem|em|pt)\1/g;

/** 间距 token：--generative-ui-space-*: 4/8/12px（允许） */
const SPACE_TOKEN_PX = /--generative-ui-space-[a-zA-Z0-9_-]+\s*:\s*(\d+(?:\.\d+)?)px\b/g;

function stripSourceComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          out += source[i];
          i += 1;
          break;
        }
        out += source[i];
        i += 1;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function isFontSizeExemptPath(relPath: string): boolean {
  const normalized = relPath.replaceAll('\\', '/');
  const base = path.basename(normalized);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/(^|\/)(__tests__|__mocks__)(\/|$)/.test(normalized)) return true;
  if (/few[-_]?shot|negative[-_]?example/i.test(normalized)) return true;
  return false;
}

function collectSourceFiles(target: string): string[] {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return SCAN_EXT.has(path.extname(target)) ? [target] : [];
  }
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') return [];
      return collectSourceFiles(absolute);
    }
    return SCAN_EXT.has(path.extname(entry.name)) ? [absolute] : [];
  });
}

function findBareFontSizeViolations(source: string): Array<{ line: number; match: string }> {
  const stripped = stripSourceComments(source);
  const violations: Array<{ line: number; match: string }> = [];
  const lines = stripped.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNo = index + 1;

    TAILWIND_ARBITRARY_FONT_SIZE.lastIndex = 0;
    for (const match of line.matchAll(TAILWIND_ARBITRARY_FONT_SIZE)) {
      violations.push({ line: lineNo, match: match[1] });
    }

    CSS_FONT_SIZE.lastIndex = 0;
    for (const match of line.matchAll(CSS_FONT_SIZE)) {
      violations.push({ line: lineNo, match: match[0] });
    }

    JS_FONT_SIZE_NUMBER.lastIndex = 0;
    for (const match of line.matchAll(JS_FONT_SIZE_NUMBER)) {
      violations.push({ line: lineNo, match: match[0] });
    }

    JS_FONT_SIZE_STRING.lastIndex = 0;
    for (const match of line.matchAll(JS_FONT_SIZE_STRING)) {
      violations.push({ line: lineNo, match: match[0] });
    }

    SPACE_TOKEN_PX.lastIndex = 0;
    for (const match of line.matchAll(SPACE_TOKEN_PX)) {
      const px = Number(match[1]);
      if (!ALLOWED_SPACE_PX.has(px)) {
        violations.push({ line: lineNo, match: match[0] });
      }
    }
  }

  return violations;
}

describe('generativeUI fontSizeToken contract', () => {
  it('scanner treats comments / tokens / spacing vars as ok and flags bare px font sizes', () => {
    expect(findBareFontSizeViolations('className="text-xs text-sm text-base text-lg text-caption"')).toEqual([]);
    expect(findBareFontSizeViolations('className="text-[hsl(var(--success))]"')).toEqual([]);
    expect(findBareFontSizeViolations('className="text-[color:hsl(var(--primary))]"')).toEqual([]);
    expect(findBareFontSizeViolations('font-size: var(--m-text-caption);')).toEqual([]);
    expect(findBareFontSizeViolations('--generative-ui-space-1: 4px;')).toEqual([]);
    expect(findBareFontSizeViolations('--generative-ui-space-2: 8px;\n--generative-ui-space-3: 12px;')).toEqual([]);
    expect(findBareFontSizeViolations('gap: 4px; width: 8px; padding: 12px;')).toEqual([]);
    expect(findBareFontSizeViolations('// leftover text-[13px] and fontSize: 14')).toEqual([]);
    expect(findBareFontSizeViolations('/* font-size: 11px */\nconst x = 1;')).toEqual([]);

    expect(findBareFontSizeViolations('className="text-[13px]"')).toEqual([
      { line: 1, match: 'text-[13px]' },
    ]);
    expect(findBareFontSizeViolations('className="sm:text-[10px] font-normal"')).toEqual([
      { line: 1, match: 'sm:text-[10px]' },
    ]);
    expect(findBareFontSizeViolations('font-size: 14px;')).toEqual([
      { line: 1, match: 'font-size: 14px' },
    ]);
    expect(findBareFontSizeViolations('style={{ fontSize: 14 }}')).toEqual([
      { line: 1, match: 'fontSize: 14' },
    ]);
    expect(findBareFontSizeViolations("style={{ fontSize: '12px' }}")).toEqual([
      { line: 1, match: "fontSize: '12px'" },
    ]);
    expect(findBareFontSizeViolations('--generative-ui-space-4: 16px;')).toEqual([
      { line: 1, match: '--generative-ui-space-4: 16px' },
    ]);

    expect(isFontSizeExemptPath('prompts/fewShotExamples.ts')).toBe(true);
    expect(isFontSizeExemptPath('components/ChartBlock.negativeExample.ts')).toBe(true);
    expect(isFontSizeExemptPath('components/ChartBlock.test.tsx')).toBe(true);
    expect(isFontSizeExemptPath('components/ChartBlock.tsx')).toBe(false);
    expect(isFontSizeExemptPath('src/features/generative-ui/generative-ui.css')).toBe(false);
  });

  it('components and generative-ui.css have no bare px font sizes', () => {
    const files = SCAN_ROOTS.flatMap(collectSourceFiles);
    expect(files.length, 'expected generative-ui components + css source files').toBeGreaterThan(0);

    const violations: string[] = [];
    for (const abs of files) {
      const rel = path.relative(REPO, abs).replaceAll('\\', '/');
      if (isFontSizeExemptPath(rel)) continue;
      const source = fs.readFileSync(abs, 'utf8');
      for (const hit of findBareFontSizeViolations(source)) {
        violations.push(`${rel}:${hit.line} ${hit.match}`);
      }
    }

    expect(
      violations,
      `bare font size must be text-xs/sm/base (or constitution text-lg/text-caption):\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
