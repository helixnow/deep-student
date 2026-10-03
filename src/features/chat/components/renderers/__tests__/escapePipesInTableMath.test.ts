import { describe, expect, it } from 'vitest';
import { escapePipesInTableMath } from '../MarkdownRenderer';

describe('escapePipesInTableMath', () => {
  it('表格行里公式内的 | 改写为 \\vert，单元格不再被切断', () => {
    const row = '| 50 min | Q13 $A=\\alpha\\alpha^{\\mathsf T}$ 的特征值与 $|E+A^n|$（约 8 min） |';
    expect(escapePipesInTableMath(row)).toBe(
      '| 50 min | Q13 $A=\\alpha\\alpha^{\\mathsf T}$ 的特征值与 $\\vert E+A^n\\vert $（约 8 min） |',
    );
  });

  it('范数 \\| 改写为 \\Vert', () => {
    expect(escapePipesInTableMath('| 范数 | $\\|x\\|_2$ |')).toBe('| 范数 | $\\Vert x\\Vert _2$ |');
  });

  it('非表格行、表格分隔符、货币不受影响', () => {
    const text = [
      '正文里的 $|A|$ 不动',
      '| 价格 | 区间 |',
      '|---|---|',
      '| $5 | $10 |',
    ].join('\n');
    expect(escapePipesInTableMath(text)).toBe(text);
  });
});
