import { describe, it, expect } from 'vitest';
import { chartBlockPropsSchema } from '@/features/generative-ui/components/ChartBlock';
import { buildTranslationBriefingIntent } from '@/features/generative-ui/utils/buildTranslationBriefingIntent';
import { parseGenerativeUIIntent } from '@/features/generative-ui/schema';

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
  emptySourceTitle: 'No source',
  segmentsTitle: 'Segments',
  segmentsEmpty: 'No segments',
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
    expect(intent.blocks.some((b) => b.type === 'list')).toBe(true);
    const chart = intent.blocks.find((b) => b.type === 'chart');
    expect(chart).toBeDefined();
    expect((chart?.props as { series?: Array<{ values: number[] }> }).series?.[0]?.values).toEqual([100, 60]);
    expect(chartBlockPropsSchema.safeParse(chart?.props).success).toBe(true);
    expect(
      intent.blocks.filter((b) => b.type === 'stat-card').map((b) => (b.props as { title?: string }).title),
    ).toEqual(['Source', 'Translated']);
    const actionBar = intent.blocks.find((b) => b.type === 'action-bar');
    const actions = (actionBar?.props as { actions?: Array<{ id: string }> })?.actions ?? [];
    expect(actions.map((a) => a.id)).toEqual(['copy-translation', 'open-settings']);
    expect(parseGenerativeUIIntent(JSON.stringify(intent)).ok).toBe(true);
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

  it('uses streaming progress title when isStreaming', () => {
    const intent = buildTranslationBriefingIntent({
      sourceChars: 100,
      translatedChars: 40,
      srcLangLabel: 'English',
      tgtLangLabel: 'Chinese',
      isStreaming: true,
      labels: { ...labels, streamingProgressTitle: 'Translating…' },
    });
    const progress = intent.blocks.find((b) => b.type === 'progress');
    expect((progress?.props as { title?: string }).title).toBe('Translating…');
  });

  it('lists recent segments when metrics include them and alerts when source is empty', () => {
    const withSegments = buildTranslationBriefingIntent({
      sourceChars: 20,
      translatedChars: 10,
      srcLangLabel: 'English',
      tgtLangLabel: 'Chinese',
      recentSegments: [{ label: 'Hello world', badge: 'EN' }],
      labels,
    });
    const list = withSegments.blocks.find((b) => b.type === 'list');
    expect((list?.props as { items: Array<{ label: string }> }).items[0]?.label).toBe('Hello world');

    const empty = buildTranslationBriefingIntent({
      sourceChars: 0,
      translatedChars: 0,
      srcLangLabel: 'English',
      tgtLangLabel: 'Chinese',
      labels,
    });
    expect(empty.blocks.some((b) => b.type === 'alert')).toBe(true);
    expect(empty.blocks.some((b) => b.type === 'chart')).toBe(true);
    expect((empty.blocks.find((b) => b.type === 'list')?.props as { items: unknown[] }).items).toEqual([]);
    expect(parseGenerativeUIIntent(JSON.stringify(withSegments)).ok).toBe(true);
    expect(parseGenerativeUIIntent(JSON.stringify(empty)).ok).toBe(true);
  });
});
