import { describe, expect, it } from 'vitest';
import enAnki from '@/locales/en-US/anki.json';
import zhAnki from '@/locales/zh-CN/anki.json';
import enFlashcards from '@/locales/en-US/flashcards.json';
import zhFlashcards from '@/locales/zh-CN/flashcards.json';

function flattenLeafKeys(value: unknown, prefix = ''): string[] {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenLeafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function readKey(value: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((cursor, part) => {
    if (cursor == null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    return (cursor as Record<string, unknown>)[part];
  }, value);
}

describe('Anki and flashcard locale contracts', () => {
  it('keeps en-US and zh-CN leaf keys in parity', () => {
    expect(flattenLeafKeys(enAnki).sort()).toEqual(flattenLeafKeys(zhAnki).sort());
    expect(flattenLeafKeys(enFlashcards).sort()).toEqual(flattenLeafKeys(zhFlashcards).sort());
  });

  it.each([
    ['anki', enAnki, zhAnki, 'taskDashboard.loadFailed'],
    ['anki', enAnki, zhAnki, 'taskDashboard.refreshFailedStale'],
    ['anki', enAnki, zhAnki, 'taskDashboard.retry'],
    ['anki', enAnki, zhAnki, 'agent.critic.flaggedFlag'],
    ['anki', enAnki, zhAnki, 'agent.occlusion.invalidSpec'],
    ['anki', enAnki, zhAnki, 'qaFlags.cardBadge'],
    ['flashcards', enFlashcards, zhFlashcards, 'card.renderIssue'],
    ['flashcards', enFlashcards, zhFlashcards, 'card.renderIssueMore'],
    ['flashcards', enFlashcards, zhFlashcards, 'today.libraryEmpty'],
    ['flashcards', enFlashcards, zhFlashcards, 'settings.scheduler.title'],
  ] as const)('defines %s:%s in both supported locales', (_namespace, en, zh, key) => {
    expect(readKey(en, key)).toEqual(expect.any(String));
    expect(readKey(zh, key)).toEqual(expect.any(String));
  });
});
