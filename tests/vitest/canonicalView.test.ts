import { describe, expect, it } from 'vitest';

import { canonicalizeView, isSupportedView } from '@/app/navigation/canonicalView';

describe('canonicalView', () => {
  it('maps deprecated views to supported destinations', () => {
    expect(canonicalizeView('analysis')).toBe('chat-v2');
    expect(canonicalizeView('chat')).toBe('chat-v2');
    expect(canonicalizeView('notes')).toBe('learning-hub');
    expect(canonicalizeView('review')).toBe('chat-v2');
    expect(canonicalizeView('exam-sheet')).toBe('learning-hub');
    expect(canonicalizeView('textbook-library')).toBe('learning-hub');
  });

  it('keeps supported views unchanged', () => {
    expect(canonicalizeView('chat-v2')).toBe('chat-v2');
    expect(canonicalizeView('settings')).toBe('settings');
    expect(canonicalizeView('learning-hub')).toBe('learning-hub');
  });

  it('reports supported status after canonicalization', () => {
    expect(isSupportedView('analysis')).toBe(true);
    expect(isSupportedView('notes')).toBe(true);
    expect(isSupportedView('chat-v2')).toBe(true);
  });
});
