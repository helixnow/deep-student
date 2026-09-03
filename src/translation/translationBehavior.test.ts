import { describe, expect, it } from 'vitest';
import {
  isPromptCustomized,
  promptAfterDomainSwitch,
  promptForSessionLoad,
} from './promptPresets';
import { alignTexts, splitParagraphs, splitSentences } from './segmentation';
import { resolveSessionPrefs } from './sessionPrefs';

const defaults = new Set(['general default', 'academic default', 'technical default']);

describe('翻译领域预设与 prompt_override 门控', () => {
  it('空文案和任一领域默认模板都不视为用户覆盖', () => {
    expect(isPromptCustomized('', defaults)).toBe(false);
    expect(isPromptCustomized('  academic default  ', defaults)).toBe(false);
    expect(isPromptCustomized('保留专有名词原文', defaults)).toBe(true);
  });

  it('切换领域时默认文案跟随，自定义文案保持', () => {
    expect(promptAfterDomainSwitch('general default', 'academic default', defaults))
      .toBe('academic default');
    expect(promptAfterDomainSwitch('保留专有名词原文', 'academic default', defaults))
      .toBe('保留专有名词原文');
  });

  it('旧版保存的领域默认模板按当前领域归一，自定义全局提示词才跨会话恢复', () => {
    expect(promptForSessionLoad('academic default', 'general default', defaults))
      .toBe('general default');
    expect(promptForSessionLoad(null, 'technical default', defaults))
      .toBe('technical default');
    expect(promptForSessionLoad('保留公式编号', 'general default', defaults))
      .toBe('保留公式编号');
  });
});

describe('翻译会话偏好恢复', () => {
  it('按会话值 → 用户偏好 → 内建默认解析', () => {
    expect(resolveSessionPrefs(
      { srcLang: 'ja', formality: 'formal' },
      { srcLang: 'en', tgtLang: 'fr', formality: 'casual' },
    )).toEqual({ srcLang: 'ja', tgtLang: 'fr', formality: 'formal' });

    expect(resolveSessionPrefs(null, {
      srcLang: 'en',
      tgtLang: 'de',
      formality: 'casual',
    })).toEqual({ srcLang: 'en', tgtLang: 'de', formality: 'casual' });

    expect(resolveSessionPrefs(undefined, {}))
      .toEqual({ srcLang: 'auto', tgtLang: 'zh-CN', formality: 'auto' });
  });
});

describe('翻译统一分段与对齐', () => {
  it('空行分段并兼容中西文句末标点', () => {
    expect(splitParagraphs('第一段\n\n第二段\n\n\n第三段'))
      .toEqual(['第一段', '第二段', '第三段']);
    expect(splitSentences('第一句。Second sentence! 第三句？'))
      .toEqual(['第一句。', 'Second sentence!', '第三句？']);
  });

  it('段落数一致时按段硬配对', () => {
    expect(alignTexts('A\n\nB', '甲\n\n乙')).toEqual({
      pairs: [
        { src: 'A', tgt: '甲' },
        { src: 'B', tgt: '乙' },
      ],
      usedSentenceFallback: false,
    });
  });

  it('段落数不一致时按句分桶并明确标记降级', () => {
    const result = alignTexts('One. Two.\n\nThree.', '一。二。三。');
    expect(result.usedSentenceFallback).toBe(true);
    expect(result.pairs).toEqual([
      { src: 'One.', tgt: '一。' },
      { src: 'Two.', tgt: '二。' },
      { src: 'Three.', tgt: '三。' },
    ]);
  });
});
