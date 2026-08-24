import { describe, it, expect } from 'vitest';
import { appendOcrPlaceholders, fillOcrPlaceholder } from './ocrPlaceholders';

const P1 = '〔图片识别中 第 1/3 张 · a.png〕';
const P2 = '〔图片识别中 第 2/3 张 · b.png〕';
const P3 = '〔图片识别中 第 3/3 张 · c.png〕';

describe('appendOcrPlaceholders', () => {
  it('空正文时按上传顺序拼接占位符', () => {
    expect(appendOcrPlaceholders('', [P1, P2, P3])).toBe(`${P1}\n\n${P2}\n\n${P3}`);
  });

  it('已有正文时以段落分隔追加', () => {
    expect(appendOcrPlaceholders('已有内容', [P1])).toBe(`已有内容\n\n${P1}`);
  });
});

describe('fillOcrPlaceholder（顺序回填）', () => {
  it('OCR 乱序完成时，最终文本顺序仍等于上传顺序', () => {
    let text = appendOcrPlaceholders('', [P1, P2, P3]);
    // 完成顺序：3 → 1 → 2（并发 OCR 常见乱序）
    text = fillOcrPlaceholder(text, P3, '第三张的文字');
    text = fillOcrPlaceholder(text, P1, '第一张的文字');
    text = fillOcrPlaceholder(text, P2, '第二张的文字');
    expect(text).toBe('第一张的文字\n\n第二张的文字\n\n第三张的文字');
  });

  it('识别失败（空结果）时移除占位符并收敛空行', () => {
    let text = appendOcrPlaceholders('开头', [P1, P2]);
    text = fillOcrPlaceholder(text, P1, '');
    expect(text).toBe(`开头\n\n${P2}`);
    text = fillOcrPlaceholder(text, P2, '第二张的文字');
    expect(text).toBe('开头\n\n第二张的文字');
  });

  it('全部失败时正文还原为原始内容', () => {
    let text = appendOcrPlaceholders('原始正文', [P1, P2]);
    text = fillOcrPlaceholder(text, P1, '');
    text = fillOcrPlaceholder(text, P2, '');
    expect(text).toBe('原始正文');
  });

  it('占位符被用户手动删除：识别结果退回末尾追加', () => {
    const text = fillOcrPlaceholder('用户改过的正文', P1, '识别文字');
    expect(text).toBe('用户改过的正文\n\n识别文字');
  });

  it('占位符被用户手动删除且识别失败：正文不变', () => {
    expect(fillOcrPlaceholder('用户改过的正文', P1, '')).toBe('用户改过的正文');
  });

  it('回填内容去除首尾空白', () => {
    const text = fillOcrPlaceholder(P1, P1, '  带空白的文字\n');
    expect(text).toBe('带空白的文字');
  });
});
