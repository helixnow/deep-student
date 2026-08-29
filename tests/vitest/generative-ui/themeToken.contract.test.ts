/**
 * Contract: generative-ui 组件不得使用固定 light-only 色。
 * 必须走语义 token / 语义 class（bg-card、text-muted-foreground、hsl(var(--token))）。
 *
 * 禁止：bg-white、text-black、#fff、bg-gray-50、text-red-500、bg-[#fff] 等。
 * 豁免：注释、few-shot 负例、测试文件。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();
const SCAN_ROOTS = [path.join(REPO, 'src/features/generative-ui/components')] as const;

const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.css']);

const COLOR_UTIL =
  '(?:bg|text|border|fill|stroke|ring|from|to|via|outline|divide|decoration|accent|caret|shadow|ring-offset)';
const VARIANT = '(?:[\\w-]+:)*';
const IMPORTANT = '!?';
const OPACITY = '(?:\\/(?:\\d{1,3}|\\[[^\\]]+\\]))?';
const PALETTE =
  '(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)';

/** Tailwind 固定白/黑：bg-white、hover:text-black/80、dark:bg-white/[0.06] */
const LIGHT_ONLY_CLASS = new RegExp(
  `(?:^|[\\s"'\\\`])${VARIANT}${IMPORTANT}${COLOR_UTIL}-(?:white|black)${OPACITY}(?=$|[\\s"'\\\`])`,
  'g',
);

/** Tailwind 数字色板：bg-gray-50、text-red-500、border-slate-200 */
const PALETTE_CLASS = new RegExp(
  `(?:^|[\\s"'\\\`])${VARIANT}${IMPORTANT}${COLOR_UTIL}-${PALETTE}-\\d{2,3}${OPACITY}(?=$|[\\s"'\\\`])`,
  'g',
);

/** 任意值 hex class：bg-[#fff]、text-[#000000] */
const ARBITRARY_HEX_CLASS = new RegExp(
  `(?:^|[\\s"'\\\`])${VARIANT}${IMPORTANT}${COLOR_UTIL}-\\[#(?:[0-9a-fA-F]{3,8})\\](?=$|[\\s"'\\\`])`,
  'g',
);

/** #rgb / #rrggbb，不吞 #rgba / #rrggbbaa */
const BARE_HEX = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

/** style 里的 named white/black（避开 whitespace-*） */
const NAMED_CSS_COLOR =
  /(?:^|[^\w-])(?:color|background(?:-color)?|border-color|outline-color|fill|stroke)\s*[:=]\s*['"]?(?:white|black)['"]?(?=$|[^\w-])/gi;

/** rgb/rgba(255,255,255) / rgb(0,0,0) */
const RGB_LIGHT_ONLY =
  /rgba?\(\s*(?:255(?:\s*,\s*|\s+)255(?:\s*,\s*|\s+)255|0(?:\s*,\s*|\s+)0(?:\s*,\s*|\s+)0)(?:\s*,\s*[\d.]+\s*)?\)/g;

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

function isThemeTokenExemptPath(relPath: string): boolean {
  const normalized = relPath.replaceAll('\\', '/');
  const base = path.basename(normalized);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/(^|\/)(__tests__|__mocks__)(\/|$)/.test(normalized)) return true;
  if (/few[-_]?shot|negative[-_]?example/i.test(normalized)) return true;
  return false;
}

function collectSourceFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') return [];
      return collectSourceFiles(absolute);
    }
    return SCAN_EXT.has(path.extname(entry.name)) ? [absolute] : [];
  });
}

function collectLineMatches(
  line: string,
  pattern: RegExp,
): string[] {
  const matches: string[] = [];
  pattern.lastIndex = 0;
  for (const hit of line.matchAll(pattern)) {
    const raw = hit[0].trim();
    matches.push(raw.replace(/^['"`]/, ''));
  }
  return matches;
}

function findThemeTokenViolations(source: string): Array<{ line: number; match: string }> {
  const stripped = stripSourceComments(source);
  const violations: Array<{ line: number; match: string }> = [];
  const lines = stripped.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const seen = new Set<string>();
    const patterns = [LIGHT_ONLY_CLASS, PALETTE_CLASS, ARBITRARY_HEX_CLASS, BARE_HEX, NAMED_CSS_COLOR, RGB_LIGHT_ONLY];
    for (const pattern of patterns) {
      for (const match of collectLineMatches(line, pattern)) {
        if (seen.has(match)) continue;
        seen.add(match);
        violations.push({ line: index + 1, match });
      }
    }
  }

  return violations;
}

describe('generativeUI themeToken contract', () => {
  it('scanner treats comments / few-shot / tests as exempt and flags light-only colors', () => {
    expect(findThemeTokenViolations("const ok = 'hsl(var(--primary))';")).toEqual([]);
    expect(findThemeTokenViolations('const cls = "bg-card text-muted-foreground border-border";')).toEqual([]);
    expect(findThemeTokenViolations('const wrap = "whitespace-pre-wrap text-sm text-left";')).toEqual([]);
    expect(findThemeTokenViolations('const tone = "text-success bg-info/10 text-foreground";')).toEqual([]);
    expect(findThemeTokenViolations('// leftover bg-white text-black #fff')).toEqual([]);
    expect(findThemeTokenViolations('/* Research #7 was #ffffff on bg-white */\nconst x = 1;')).toEqual([]);

    expect(findThemeTokenViolations('className="bg-white"')).toEqual([{ line: 1, match: 'bg-white' }]);
    expect(findThemeTokenViolations('className="text-black"')).toEqual([{ line: 1, match: 'text-black' }]);
    expect(findThemeTokenViolations('className="hover:bg-white/90 dark:text-black/[0.04]"')).toEqual([
      { line: 1, match: 'hover:bg-white/90' },
      { line: 1, match: 'dark:text-black/[0.04]' },
    ]);
    expect(findThemeTokenViolations("const bad = '#fff';")).toEqual([{ line: 1, match: '#fff' }]);
    expect(findThemeTokenViolations("const hex = '#ffffff';")).toEqual([{ line: 1, match: '#ffffff' }]);
    expect(findThemeTokenViolations('className="bg-[#fff]"')).toEqual([
      { line: 1, match: 'bg-[#fff]' },
      { line: 1, match: '#fff' },
    ]);
    expect(findThemeTokenViolations('className="bg-gray-50 text-red-500"')).toEqual([
      { line: 1, match: 'bg-gray-50' },
      { line: 1, match: 'text-red-500' },
    ]);
    expect(findThemeTokenViolations("const color: React.CSSProperties = { color: 'white' };")).toEqual([
      { line: 1, match: "color: 'white'" },
    ]);
    expect(findThemeTokenViolations('background: rgb(255, 255, 255);')).toEqual([
      { line: 1, match: 'rgb(255, 255, 255)' },
    ]);
    expect(findThemeTokenViolations('const id = "#7"; const rgba = "#fff0";')).toEqual([]);

    expect(isThemeTokenExemptPath('prompts/fewShotExamples.ts')).toBe(true);
    expect(isThemeTokenExemptPath('components/ChartBlock.negativeExample.ts')).toBe(true);
    expect(isThemeTokenExemptPath('components/ChartBlock.test.tsx')).toBe(true);
    expect(isThemeTokenExemptPath('components/ChartBlock.tsx')).toBe(false);
  });

  it('components stay on semantic tokens instead of light-only colors', () => {
    const files = SCAN_ROOTS.flatMap(collectSourceFiles);
    expect(files.length, 'expected generative-ui components source files').toBeGreaterThan(0);

    const violations: string[] = [];
    for (const abs of files) {
      const rel = path.relative(REPO, abs).replaceAll('\\', '/');
      if (isThemeTokenExemptPath(rel)) continue;
      const source = fs.readFileSync(abs, 'utf8');
      for (const hit of findThemeTokenViolations(source)) {
        violations.push(`${rel}:${hit.line} ${hit.match}`);
      }
    }

    expect(
      violations,
      `light-only colors must be semantic tokens (bg-card / text-muted-foreground / hsl(var(--token))):\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
