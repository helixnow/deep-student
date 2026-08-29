import { describe, it, expect } from 'vitest';
import { textUnits, truncateByUnits, wrapRadarLabel } from './radarLabel';

describe('textUnits', () => {
  it('CJK 记 2 单位，拉丁记 1 单位', () => {
    expect(textUnits('内容')).toBe(4);
    expect(textUnits('Task')).toBe(4);
    expect(textUnits('内容A')).toBe(5);
  });
});

describe('wrapRadarLabel（雷达维度标签换行）', () => {
  it('中文短维度名单行原样返回', () => {
    expect(wrapRadarLabel('内容')).toEqual(['内容']);
    expect(wrapRadarLabel('发展等级')).toEqual(['发展等级']);
  });

  it('英文长维度名在空格处断为两行且完整可读（不再 6 字硬截断）', () => {
    const lines = wrapRadarLabel('Lexical Resource');
    expect(lines).toEqual(['Lexical', 'Resource']);
  });

  it('超长英文第二行才按预算截断加省略号', () => {
    const lines = wrapRadarLabel('Grammatical Range and Accuracy');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('Grammatical');
    expect(lines[1].endsWith('…')).toBe(true);
  });

  it('超长中文（无空格）按宽度硬断行', () => {
    const lines = wrapRadarLabel('内容立意结构语言表达');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('内容立意结构');
    expect(lines[1]).toBe('语言表达');
  });

  it('空白输入返回单个空行', () => {
    expect(wrapRadarLabel('  ')).toEqual(['']);
  });
});

describe('truncateByUnits', () => {
  it('预算内原样返回', () => {
    expect(truncateByUnits('short', 12)).toBe('short');
  });

  it('超出预算时截断加省略号', () => {
    expect(truncateByUnits('averyveryverylongword', 12)).toBe('averyveryver…');
  });
});
