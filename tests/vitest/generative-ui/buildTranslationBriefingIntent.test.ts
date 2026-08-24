import { describe, it, expect } from 'vitest';
import { buildTranslationBriefingIntent } from '@/features/generative-ui/utils/buildTranslationBriefingIntent';

const labels = {
  sourceStatTitle: 'Source',
  translatedStatTitle: 'Translated',
  emptyTrend: 'Empty',
  progressTitle: 'Progress',
  translatedRow: '{{count}} done',
  languagePairRow: 'Languages',
  formalityRow: 'Tone',
  domainRow: 'Domain',
  glossaryRow: 'Glossary',
  openSettings: 'Settings',
  copyTranslation: 'Copy',
};

describe('buildTranslationBriefingIntent', () => {
  it('builds progress and copy action when translation exists', () => {
    const intent = buildTranslationBriefingIntent({
      sourceChars: 100,
      translatedChars: 60,
      srcLangLabel: 'English',
      tgtLangLabel: 'Chinese',
      formalityLabel: 'Formal',
      domainLabel: 'Technical',
      glossaryCount: 2,
      labels,
    });

    expect(intent.blocks.some((b) => b.type === 'progress')).toBe(true);
    const actionBar = intent.blocks.find((b) => b.type === 'action-bar');
    const actions = (actionBar?.props as { actions?: Array<{ id: string }> })?.actions ?? [];
    expect(actions.map((a) => a.id)).toEqual(['copy-translation', 'open-settings']);
  });

  it('omits copy action when no translation yet', () => {
    const intent = buildTranslationBriefingIntent({
      sourceChars: 50,
      translatedChars: 0,
      srcLangLabel: 'English',
      tgtLangLabel: 'Chinese',
      labels,
    });
    const actionBar = intent.blocks.find((b) => b.type === 'action-bar');
    const actions = (actionBar?.props as { actions?: Array<{ id: string }> })?.actions ?? [];
    expect(actions.map((a) => a.id)).toEqual(['open-settings']);
  });
});
