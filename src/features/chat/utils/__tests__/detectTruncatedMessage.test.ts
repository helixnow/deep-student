import { describe, expect, it } from 'vitest';
import { isLikelyTruncatedAssistantMessage } from '../detectTruncatedMessage';

describe('isLikelyTruncatedAssistantMessage', () => {
  it('returns false while streaming or pending or cancelled', () => {
    expect(isLikelyTruncatedAssistantMessage({
      status: 'streaming',
      finishReason: 'length',
      content: 'Partial content:',
      hasStreamingBlocks: true,
    })).toBe(false);

    expect(isLikelyTruncatedAssistantMessage({
      status: 'cancelled',
      content: 'Stopped content：',
    })).toBe(false);
  });

  it('detects explicit truncated flag and length finishReason', () => {
    expect(isLikelyTruncatedAssistantMessage({
      status: 'success',
      truncated: true,
      content: 'Short partial output',
    })).toBe(true);

    expect(isLikelyTruncatedAssistantMessage({
      status: 'success',
      finishReason: 'length',
      content: 'Output hit token limit.',
    })).toBe(true);

    expect(isLikelyTruncatedAssistantMessage({
      status: 'success',
      finishReason: 'MAX_TOKENS',
      content: 'Output hit max tokens.',
    })).toBe(true);
  });

  it('detects unclosed code fence or unclosed display math on long completed replies', () => {
    const longPrefix = 'A'.repeat(210);
    expect(isLikelyTruncatedAssistantMessage({
      status: 'success',
      content: `${longPrefix}\n\`\`\`python\ndef solve():\n    return 1`,
    })).toBe(true);

    expect(isLikelyTruncatedAssistantMessage({
      status: 'success',
      content: `${longPrefix}\n$$\nx = \\frac{1}{2}`,
    })).toBe(true);
  });

  it('detects dangling connectors and colons on long completed replies', () => {
    const longPrefix = '这是一段比较长的推导过程与数学说明。'.repeat(15);
    expect(isLikelyTruncatedAssistantMessage({
      status: 'success',
      content: `${longPrefix}建议写成：`,
    })).toBe(true);

    expect(isLikelyTruncatedAssistantMessage({
      status: 'success',
      content: `${longPrefix}于是`,
    })).toBe(true);
  });

  it('returns false for complete replies and short colon lines', () => {
    expect(isLikelyTruncatedAssistantMessage({
      status: 'success',
      finishReason: 'stop',
      content: '简短提示：',
    })).toBe(false);

    const completeLong = `${'推导结论已验证完毕。'.repeat(20)}\n\`\`\`ts\nconst ok = true;\n\`\`\`\n$$\na^2 + b^2 = c^2\n$$\n总结完毕。`;
    expect(isLikelyTruncatedAssistantMessage({
      status: 'success',
      finishReason: 'stop',
      content: completeLong,
    })).toBe(false);
  });
});
