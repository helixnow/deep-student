import { describe, expect, it } from 'vitest';
import { sanitizeDanglingMarkdown } from '../sanitizeDanglingMarkdown';

describe('sanitizeDanglingMarkdown', () => {
  it('closes an unclosed bold marker at the tail', () => {
    const { text, touched } = sanitizeDanglingMarkdown('前文 **加粗内容');
    expect(touched).toBe(true);
    expect(text).toBe('前文 **加粗内容**');
  });

  it('closes an unclosed strikethrough pair marker', () => {
    const { text } = sanitizeDanglingMarkdown('前文 ~~删除线');
    expect(text).toBe('前文 ~~删除线~~');
  });

  it('closes an unclosed fenced code block', () => {
    const { text } = sanitizeDanglingMarkdown('```js\nconst a = 1;');
    expect(text.endsWith('```')).toBe(true);
  });

  it('does not count asterisk list markers as emphasis tokens', () => {
    const input = '* 第一项\n* 第二项\n* 第三项';
    const { text, touched } = sanitizeDanglingMarkdown(input);
    expect(touched).toBe(false);
    expect(text).toBe(input);
  });

  it('closes bold inside asterisk list items without extra markers', () => {
    const { text } = sanitizeDanglingMarkdown('* **要点一**：完整\n* **要点二');
    expect(text).toBe('* **要点一**：完整\n* **要点二**');
  });

  it('ignores horizontal rule lines when counting markers', () => {
    const input = '第一段\n\n***\n\n第二段';
    const { text, touched } = sanitizeDanglingMarkdown(input);
    expect(touched).toBe(false);
    expect(text).toBe(input);
  });

  it('keeps bold pairing intact after a horizontal rule', () => {
    const { text } = sanitizeDanglingMarkdown('***\n\n这是 **加粗');
    expect(text).toBe('***\n\n这是 **加粗**');
  });

  it('does not append a tilde for a lone approximation tilde', () => {
    const input = '大约耗时 ~5ms 完成';
    const { text, touched } = sanitizeDanglingMarkdown(input);
    expect(touched).toBe(false);
    expect(text).toBe(input);
  });

  it('trims a dangling half link until it closes', () => {
    const { text } = sanitizeDanglingMarkdown('请看 [还没补完');
    expect(text).toBe('请看 ');
  });

  it('does not trim earlier-line brackets that are not link starts', () => {
    const input = '数组访问 arr[i 这样写\n下一行还在继续输出';
    const { text } = sanitizeDanglingMarkdown(input);
    expect(text).toBe(input);
  });

  it('does not let a bracket inside an unclosed fence eat the auto-closing fence', () => {
    const { text } = sanitizeDanglingMarkdown('```js\nconst a = arr[0;');
    expect(text.endsWith('```')).toBe(true);
    expect(text).toContain('arr[0;');
  });

  it('ignores brackets inside closed inline code on the last line', () => {
    const input = '见 `arr[0` 用法';
    const { text } = sanitizeDanglingMarkdown(input);
    expect(text).toBe(input);
  });

  it('does not count backslash-escaped markers', () => {
    const input = '乘法 3 \\* 4 结果为 12';
    const { text, touched } = sanitizeDanglingMarkdown(input);
    expect(touched).toBe(false);
    expect(text).toBe(input);
  });

  it('does not count intraword underscores in identifiers', () => {
    const input = '变量 my_var 与 another_name 命名';
    const { text, touched } = sanitizeDanglingMarkdown(input);
    // my_var / another_name 共 2 个词内下划线，但都不构成强调边界
    expect(touched).toBe(false);
    expect(text).toBe(input);
  });
});
