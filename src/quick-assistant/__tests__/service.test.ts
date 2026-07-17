import { describe, expect, it } from 'vitest';
import { inferQuickActions, isCaptureLikeText } from '../service';

describe('inferQuickActions', () => {
  it('prioritizes hints for exercise-like content', () => {
    expect(inferQuickActions('已知 x + 2 = 8，求 x')).toEqual(['hint', 'explain', 'ask']);
  });

  it('prioritizes translation for foreign language excerpts', () => {
    expect(inferQuickActions('Photosynthesis converts light energy into chemical energy.')[0]).toBe('translate');
  });

  it('prioritizes direct answers for questions', () => {
    expect(inferQuickActions('为什么天空是蓝色？')[0]).toBe('ask');
  });

  it('uses explanation as the neutral default', () => {
    expect(inferQuickActions('牛顿第二定律的基本内容')[0]).toBe('explain');
  });
});

describe('isCaptureLikeText', () => {
  it('treats multiline paste as capture material', () => {
    expect(isCaptureLikeText('第一行\n第二行')).toBe(true);
  });

  it('treats long paragraphs as capture material', () => {
    expect(isCaptureLikeText('这段话很长，'.repeat(20))).toBe(true);
  });

  it('keeps short single-line questions in the input box', () => {
    expect(isCaptureLikeText('什么是熵？')).toBe(false);
  });

  it('ignores whitespace-only paste', () => {
    expect(isCaptureLikeText('   \n  ')).toBe(false);
  });
});
