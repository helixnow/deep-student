import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
// boundary-allow cross-plugin-impl: 核对批改工具提示里引用的工具名都有 Host 执行器
import { ESSAY_TOOL_NAMES } from '../../review/src/essay-tool-executor.ts';
// boundary-allow cross-plugin-impl: 同上
import { REVIEW_TOOL_NAMES } from '../../review/src/review-tool-executor.ts';
import { QBANK_PENDING_TOOL_NAMES, QBANK_TOOL_NAMES } from '../src/tools/qbank-tool-executor.ts';

const EXECUTABLE = new Set<string>([...QBANK_TOOL_NAMES, ...REVIEW_TOOL_NAMES, ...ESSAY_TOOL_NAMES]);

const HINT_SOURCES = [
  '../../review/src/essay-tool-executor.ts',
  '../src/tools/qbank-tools-authoring.ts',
  '../src/tools/qbank-tools-import.ts',
];

function referencedTools(relative: string): string[] {
  const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
  const names = new Set<string>();
  for (const literal of source.matchAll(/'([^'\n]*[\u4e00-\u9fff][^'\n]*)'|`([^`]*[\u4e00-\u9fff][^`]*)`/g)) {
    for (const match of (literal[1] ?? literal[2] ?? '').matchAll(/\b((?:qbank|review|essay)_[a-z_]+)\b(?!\.rs)/g)) names.add(match[1]!);
  }
  return [...names].sort();
}

describe('W12 交接：提示文本引导模型调用的工具都可执行（不会被 Host 扣留）', () => {
  it('qbank_batch_import 有执行器，且没有待实现的 qbank 工具', () => {
    expect(QBANK_TOOL_NAMES).toContain('qbank_batch_import');
    expect([...QBANK_PENDING_TOOL_NAMES]).toEqual([]);
  });

  for (const relative of HINT_SOURCES) {
    it(`${relative} 中文提示里提到的工具名都在执行器名单中`, () => {
      const names = referencedTools(relative);
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter(name => !EXECUTABLE.has(name))).toEqual([]);
    });
  }
});
