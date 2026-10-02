import { describe, expect, it } from 'vitest';
import { buildEssayAutoTitle, buildTranslationAutoTitle, isDefaultResourceName } from '../autoTitle';

const join = (mode: string, subject: string) => `${mode}：${subject}`;

describe('isDefaultResourceName', () => {
  it('treats fresh and numbered default names as replaceable', () => {
    expect(isDefaultResourceName('新作文', 'essay')).toBe(true);
    expect(isDefaultResourceName('新作文 3', 'essay')).toBe(true);
    expect(isDefaultResourceName('新翻译 2', 'translation')).toBe(true);
    expect(isDefaultResourceName('  ', 'essay')).toBe(true);
    expect(isDefaultResourceName('未命名作文', 'essay', '未命名作文')).toBe(true);
  });

  it('keeps names the user chose', () => {
    expect(isDefaultResourceName('雅思大作文：远程办公的利弊', 'essay')).toBe(false);
    expect(isDefaultResourceName('新作文练习', 'essay')).toBe(false);
    expect(isDefaultResourceName('新作文', 'translation')).toBe(false);
  });
});

describe('buildEssayAutoTitle', () => {
  it('prefers the topic and prefixes the grading mode', () => {
    expect(buildEssayAutoTitle({
      topicText: '\n大学教育该不该免费\n请讨论双方观点',
      inputText: 'Some people believe that university education should be free.',
      modeName: '雅思大作文',
      join,
    })).toBe('雅思大作文：大学教育该不该免费');
  });

  it('falls back to the first sentence of the essay and truncates long subjects', () => {
    expect(buildEssayAutoTitle({
      inputText: 'Some people believe that university education should be free for everyone. Others disagree.',
      join,
    })).toBe('Some people believe that…');

    expect(buildEssayAutoTitle({
      inputText: '我认为大学应该免费。因为教育是公共品。',
      modeName: '日常练习',
      join,
    })).toBe('日常练习：我认为大学应该免费。');
  });

  it('does not split on decimals and returns null for empty input', () => {
    expect(buildEssayAutoTitle({ inputText: 'Band 6.5 is enough', join })).toBe('Band 6.5 is enough');
    expect(buildEssayAutoTitle({ topicText: ' ', inputText: '\n', join })).toBeNull();
  });
});

describe('buildTranslationAutoTitle', () => {
  it('uses the first source line and backs off to a word boundary', () => {
    expect(buildTranslationAutoTitle('\nThe testing effect refers to the finding that retrieval helps.\nSecond line'))
      .toBe('The testing effect…');
    expect(buildTranslationAutoTitle('检索练习能显著提升长期记忆')).toBe('检索练习能显著提升长期记忆');
    expect(buildTranslationAutoTitle('   ')).toBeNull();
  });
});
