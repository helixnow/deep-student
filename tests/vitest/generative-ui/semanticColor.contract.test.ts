/**
 * Contract: generative-ui 组件 / 块不得含裸 hex（#rgb / #rrggbb）。
 * 颜色必须走 hsl(var(--token)) 或语义 class（text-muted-foreground 等）。
 *
 * 豁免：注释、few-shot 负例文件、测试文件。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();
const SCAN_ROOTS = [
  path.join(REPO, 'src/features/generative-ui/components'),
  path.join(REPO, 'src/features/generative-ui/blocks'),
] as const;

const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.css']);

/** #rgb 或 #rrggbb，不吞 #rgba / #rrggbbaa */
const BARE_HEX = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

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

function isSemanticColorExemptPath(relPath: string): boolean {
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

function findBareHexViolations(source: string): Array<{ line: number; match: string }> {
  const stripped = stripSourceComments(source);
  const violations: Array<{ line: number; match: string }> = [];
  const lines = stripped.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const match of line.matchAll(BARE_HEX)) {
      violations.push({ line: index + 1, match: match[0] });
    }
  }
  return violations;
}

describe('generativeUI semanticColor contract', () => {
  it('scanner treats comments / few-shot / tests as exempt and flags live hex', () => {
    expect(findBareHexViolations("const ok = 'hsl(var(--primary))';")).toEqual([]);
    expect(findBareHexViolations('const cls = "text-muted-foreground";')).toEqual([]);
    expect(findBareHexViolations('// leftover #fff and #00AAFF')).toEqual([]);
    expect(findBareHexViolations('/* Research #7 was #112233 */\nconst x = 1;')).toEqual([]);
    expect(findBareHexViolations("const bad = '#FF5500';")).toEqual([{ line: 1, match: '#FF5500' }]);
    expect(findBareHexViolations('className="bg-[#abc]"')).toEqual([{ line: 1, match: '#abc' }]);
    expect(findBareHexViolations('const id = "#7"; const rgba = "#fff0";')).toEqual([]);

    expect(isSemanticColorExemptPath('prompts/fewShotExamples.ts')).toBe(true);
    expect(isSemanticColorExemptPath('components/ChartBlock.negativeExample.ts')).toBe(true);
    expect(isSemanticColorExemptPath('components/ChartBlock.test.tsx')).toBe(true);
    expect(isSemanticColorExemptPath('components/ChartBlock.tsx')).toBe(false);
  });

  it('components and blocks have no bare #rgb / #rrggbb', () => {
    const files = SCAN_ROOTS.flatMap(collectSourceFiles);
    expect(files.length, 'expected generative-ui components/blocks source files').toBeGreaterThan(0);

    const violations: string[] = [];
    for (const abs of files) {
      const rel = path.relative(REPO, abs).replaceAll('\\', '/');
      if (isSemanticColorExemptPath(rel)) continue;
      const source = fs.readFileSync(abs, 'utf8');
      for (const hit of findBareHexViolations(source)) {
        violations.push(`${rel}:${hit.line} ${hit.match}`);
      }
    }

    expect(violations, `bare hex must be hsl(var(--token)) or a semantic class:\n${violations.join('\n')}`).toEqual(
      [],
    );
  });
});
