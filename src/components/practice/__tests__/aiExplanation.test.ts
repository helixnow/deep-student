import { describe, expect, it } from 'vitest';
import { resolveAiExplanationWrite, toExplanationText } from '../aiExplanation';

describe('AI 解析写入规则（#467）', () => {
  it('strips grading tags before saving as explanation', () => {
    expect(toExplanationText('思路……\n<verdict>partial</verdict>\n<score value="60"/>')).toBe('思路……');
    expect(toExplanationText(undefined)).toBe('');
  });

  it('writes directly only when the explanation is empty', () => {
    expect(resolveAiExplanationWrite(undefined, 'AI 解析')).toBe('write');
    expect(resolveAiExplanationWrite('   ', 'AI 解析')).toBe('write');
  });

  it('never overwrites an existing explanation without confirmation', () => {
    expect(resolveAiExplanationWrite('老师写的解析', 'AI 解析')).toBe('replace');
  });

  it('offers nothing when there is no AI text or it already matches', () => {
    expect(resolveAiExplanationWrite('解析', '')).toBe('none');
    expect(resolveAiExplanationWrite('解析', '<verdict>correct</verdict>')).toBe('none');
    expect(resolveAiExplanationWrite('同一段解析', '同一段解析\n<score value="90"/>')).toBe('none');
  });
});
