/**
 * 流式未闭合围栏保护：openui-lang / wavedrom / html-interactive 等代码块在
 * 流式到达时尚未闭合，正文预处理（表格公式竖线、CJK 加粗、LaTeX 转换）
 * 绝不能改写代码块内部内容。
 */
import { describe, expect, it } from 'vitest';
import { preprocessContent } from '@/features/chat/components/renderers/MarkdownRenderer';

describe('preprocessContent — streaming unclosed fence', () => {
  it('keeps unclosed openui-lang source byte-identical and only appends the closing fence', () => {
    const source = [
      '```openui-lang',
      'root = Stack([Table(["a|b"], [["x|y"]])])',
      'root2 = Text("**粗**体 \\(x\\)")',
    ].join('\n');

    const output = preprocessContent(source, true);

    expect(output).toBe(`${source}\n\`\`\``);
    expect(output).toContain('["a|b"]');
    expect(output).toContain('[["x|y"]]');
    expect(output).toContain('**粗**体');
    expect(output).toContain('\\(x\\)');
  });

  it('still preprocesses prose outside the unclosed fence', () => {
    const source = [
      '前言**重点**后记',
      '```openui-lang',
      'Text("中文**加粗**中文")',
    ].join('\n');

    const output = preprocessContent(source, true);

    // 正文兜底：CJK 紧邻加粗补空格
    expect(output).toContain('前言 **重点** 后记');
    // 代码块内部原样保留
    expect(output).toContain('Text("中文**加粗**中文")');
    expect(output.trimEnd().endsWith('```')).toBe(true);
  });

  it('leaves table pipe escaping intact outside the fence', () => {
    const source = [
      '| 公式 | 说明 |',
      '| --- | --- |',
      '| $|E+A^n|$ | 特征值 |',
      '```openui-lang',
      'Table(["x|y"], [["1|2"]])',
    ].join('\n');

    const output = preprocessContent(source, true);

    expect(output).toContain('$\\vert E+A^n\\vert $');
    expect(output).toContain('Table(["x|y"], [["1|2"]])');
  });

  it('does not mask a closed fence', () => {
    const source = ['```openui-lang', 'root = Stack([])', '```'].join('\n');
    expect(preprocessContent(source, true)).toBe(source);
  });
});
