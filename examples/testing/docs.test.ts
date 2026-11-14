// @vitest-environment node
/**
 * 插件开发文档防过时（规则见 examples/README.md「测试」一节）：
 * - ts/tsx 代码块第一行写 `// <仓库路径>`。路径是已有文件时，代码块是它的摘录，每行都要按顺序出现在该文件里；
 *   否则路径必须在 `examples/plugins/<新目录>/` 下，代码块按放在那里的插件做类型检查（同目录的代码块互相导入）。
 * - 文中反引号里的仓库路径必须存在，`路径:行号` 不超出文件长度，紧跟在路径后面的 `符号` 必须出现在该文件里。
 * - SECURITY.md 最后一列是“测试”的表格：每行引用测试文件，行里的错误码出现在引用的测试里。
 * - 每个示例的 Host 半按 Host 设置做类型检查（tsc -p examples/tsconfig.json 只覆盖 UI 半）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXAMPLES_DIR, examplePackages, REPO_ROOT } from './harness';
import { typecheck, type TypecheckMode } from './typecheck';

/** 一次类型检查要解析 host/ 或 src/ 的整个导入闭包（本机约 1–10 秒）。 */
const TYPECHECK_TIMEOUT = 60_000;

/** 面向社区插件作者的文档。FRONTEND-F1.md 是保留原文的历史规格，CAPABILITIES.md 是生成物。 */
const DOCS = [
  'docs/plugins/SDK.md',
  'docs/plugins/ARCHITECTURE.md',
  'docs/plugins/FRONTEND.md',
  'docs/plugins/SECURITY.md',
  'examples/README.md',
  ...examplePackages()
    .filter((e) => existsSync(path.join(e.dir, 'README.md')))
    .map((e) => `examples/plugins/${e.dirName}/README.md`),
];

/** 反引号里以这些目录开头的才算仓库路径。 */
const REPO_PATH = /^((?:host|electron|src|contracts|docs|examples|scripts|migration|decisions)\/[\w.@/-]*)(?::(\d+)(?:-(\d+))?)?$/;
const SYMBOL = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const LOCATION = /^\/\/ ((?:host|electron|src|examples)\/[\w.@/-]+\.tsx?)$/;

const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');

interface Block {
  doc: string;
  /** 代码块第一行（位置注释）在文档里的行号。 */
  line: number;
  lang: string;
  lines: string[];
}

/** 文档里的全部 fenced 代码块（允许缩进在列表里），以及去掉代码块后的正文（行号不变）。 */
function parse(doc: string): { blocks: Block[]; prose: string[] } {
  const lines = read(doc).split('\n');
  const blocks: Block[] = [];
  const prose = [...lines];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)```(\w*)\s*$/.exec(lines[i]!);
    if (!open) continue;
    const [, indent, lang] = open;
    let end = i + 1;
    while (end < lines.length && lines[end]!.trim() !== '```') end++;
    blocks.push({ doc, line: i + 2, lang: lang!, lines: lines.slice(i + 1, end).map((l) => (l.startsWith(indent!) ? l.slice(indent!.length) : l)) });
    for (let k = i; k <= end && k < lines.length; k++) prose[k] = '';
    i = end;
  }
  return { blocks, prose };
}

const parsed = DOCS.map(parse);
const codeBlocks = parsed.flatMap((p) => p.blocks).filter((b) => b.lang === 'ts' || b.lang === 'tsx');
const where = (b: Block, offset = 0) => `${b.doc}:${b.line + offset}`;
const locationOf = (b: Block) => LOCATION.exec(b.lines[0] ?? '')?.[1];
const existingExampleDirs = new Set(examplePackages().map((e) => e.dirName));

function modeOf(b: Block): TypecheckMode {
  return b.lang === 'tsx' || b.lines.some((l) => /from '@deepstudent\/ui'/.test(l)) ? 'ui' : 'host';
}

const excerpts = codeBlocks.filter((b) => {
  const location = locationOf(b);
  return location !== undefined && existsSync(path.join(REPO_ROOT, location));
});
const newFiles = codeBlocks.filter((b) => locationOf(b) !== undefined && !excerpts.includes(b));

describe('ts/tsx code blocks in the plugin docs', () => {
  it('each names its file on the first line', () => {
    expect(codeBlocks.length).toBeGreaterThan(10);
    expect(codeBlocks.filter((b) => locationOf(b) === undefined).map((b) => `${where(b)}: ${b.lines[0]}`)).toEqual([]);
  });

  it('excerpts of repository files appear in those files line by line, in order', () => {
    expect(excerpts.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const b of excerpts) {
      const fileLines = read(locationOf(b)!).split('\n').map((l) => l.trim());
      let at = 0;
      b.lines.slice(1).forEach((raw, i) => {
        const line = raw.trim();
        if (line === '' || line === '// …') return;
        const found = fileLines.indexOf(line, at);
        if (found < 0) problems.push(`${where(b, i + 1)}: not in ${locationOf(b)} (after line ${at}): ${line}`);
        else at = found + 1;
      });
    }
    expect(problems).toEqual([]);
  });

  it('new files live in their own directory under examples/plugins, once, with the extension of the block', () => {
    const problems: string[] = [];
    const seen = new Map<string, string>();
    for (const b of newFiles) {
      const location = locationOf(b)!;
      const dir = /^examples\/plugins\/([^/]+)\//.exec(location)?.[1];
      if (!dir) problems.push(`${where(b)}: ${location} is neither an existing file nor under examples/plugins/<dir>/`);
      else if (existingExampleDirs.has(dir)) problems.push(`${where(b)}: ${location} would be a new file inside the real example ${dir}`);
      if (path.extname(location) !== `.${b.lang}`) problems.push(`${where(b)}: a ${b.lang} block cannot be ${location}`);
      if (seen.has(location)) problems.push(`${where(b)}: ${location} is already used at ${seen.get(location)}`);
      seen.set(location, where(b));
    }
    expect(problems).toEqual([]);
  });

  describe.each(['host', 'ui'] as const)('new files checked as %s code', (mode) => {
    const blocks = newFiles.filter((b) => modeOf(b) === mode);

    it('type-check with strict settings (host: tsconfig.host.json, ui: examples/tsconfig.json)', () => {
      expect(blocks.length).toBeGreaterThan(0);
      const byFile = new Map(blocks.map((b) => [path.join(REPO_ROOT, locationOf(b)!), b]));
      const files = new Map([...byFile].map(([file, b]) => [file, `${b.lines.join('\n')}\n`]));
      const problems = typecheck(files, mode).map((d) => `${where(byFile.get(d.file)!, d.line - 1)}: ${d.message}`);
      expect(problems).toEqual([]);
    }, TYPECHECK_TIMEOUT);
  });
});

describe('repository references in the plugin docs', () => {
  it('paths exist, line numbers are in range, and the symbols named right after a path are in that file', () => {
    let checked = 0;
    const problems: string[] = [];
    parsed.forEach(({ prose }, d) => {
      prose.forEach((text, i) => {
        const spans = [...text.matchAll(/`([^`]+)`/g)];
        spans.forEach((span, k) => {
          const ref = REPO_PATH.exec(span[1]!);
          if (!ref) return;
          const [, file, start, end] = ref;
          const at = `${DOCS[d]}:${i + 1}`;
          const abs = path.join(REPO_ROOT, file!);
          checked++;
          if (!existsSync(abs)) return void problems.push(`${at}: ${file} does not exist`);
          if (statSync(abs).isDirectory()) return;
          const content = read(file!);
          const last = Number(end ?? start ?? 0);
          const length = content.split('\n').length;
          if (last > length) problems.push(`${at}: ${span[1]} is past the end of ${file} (${length} lines)`);
          for (let n = k + 1; n < spans.length; n++) {
            const gap = text.slice(spans[n - 1]!.index! + spans[n - 1]![0].length, spans[n]!.index);
            const symbol = spans[n]![1]!;
            if (!/^\s*(?:[、,，/]\s*)?$/.test(gap) || !SYMBOL.test(symbol) || REPO_PATH.test(symbol)) break;
            for (const part of symbol.split('.')) {
              if (!new RegExp(`(?<![\\w$])${part.replace(/\$/g, '\\$')}(?![\\w$])`).test(content)) problems.push(`${at}: ${file} has no ${part} (\`${symbol}\`)`);
            }
          }
        });
      });
    });
    expect(checked).toBeGreaterThan(50);
    expect(problems).toEqual([]);
  });
});

describe('docs/plugins/SECURITY.md', () => {
  it('each row of a table whose last column is 测试 cites a test file, and its error codes appear in a cited test', () => {
    const { prose } = parsed[DOCS.indexOf('docs/plugins/SECURITY.md')]!;
    const problems: string[] = [];
    let rows = 0;
    let strict = false;
    prose.forEach((text, i) => {
      if (!text.startsWith('|')) return;
      const cells = text.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
      if (!prose[i - 1]?.startsWith('|')) {
        strict = cells.at(-1) === '测试';
        return;
      }
      if (!strict || cells.every((c) => /^-+$/.test(c))) return;
      rows++;
      const spans = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
      const tests = spans.filter((s) => /\.test\.tsx?$/.test(s) && REPO_PATH.test(s) && existsSync(path.join(REPO_ROOT, s)));
      const at = `docs/plugins/SECURITY.md:${i + 1}`;
      if (tests.length === 0) return void problems.push(`${at}: cites no test file`);
      const contents = tests.map(read);
      for (const code of new Set(spans.filter((s) => /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(s)))) {
        if (!contents.some((c) => c.includes(code))) problems.push(`${at}: ${code} is in none of ${tests.join(', ')}`);
      }
    });
    expect(rows).toBeGreaterThan(10);
    expect(problems).toEqual([]);
  });
});

describe('example plugins', () => {
  it('Host halves type-check with the Host settings (strict)', () => {
    const files = new Map(examplePackages().map((e) => [path.join(EXAMPLES_DIR, e.dirName, 'index.ts'), null]));
    expect(typecheck(files, 'host').map((d) => `${path.relative(REPO_ROOT, d.file)}:${d.line}: ${d.message}`)).toEqual([]);
  }, TYPECHECK_TIMEOUT);
});
