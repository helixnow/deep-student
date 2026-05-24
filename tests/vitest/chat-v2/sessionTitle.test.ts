import { describe, expect, it } from 'vitest';
import { getSessionTitleText } from '@/features/chat/utils/sessionTitle';

describe('getSessionTitleText', () => {
  it('returns a trimmed string title', () => {
    expect(getSessionTitleText('  Hello World  ', 'Fallback')).toBe('Hello World');
  });

  it('extracts nested title text from object-shaped session data', () => {
    expect(
      getSessionTitleText(
        { title: 'Debug Session', time: '10:00', model: 'gpt', caller: 'tool', tokens: 12, duration: 4, status: 'ok' },
        'Fallback'
      )
    ).toBe('Debug Session');
  });

  it('falls back when title is empty or unsupported', () => {
    expect(getSessionTitleText('', 'Fallback')).toBe('Fallback');
    expect(getSessionTitleText(null, 'Fallback')).toBe('Fallback');
  });
});
