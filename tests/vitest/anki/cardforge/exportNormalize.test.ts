import { describe, it, expect } from 'vitest';
import { normalizeToolExportCards } from '@/components/anki/cardforge/engines/exportNormalize';

describe('normalizeToolExportCards', () => {
  it('should preserve full card payload (text/fields/images/templateId)', () => {
    const result = normalizeToolExportCards([
      {
        id: 'card-1',
        taskId: 't1',
        templateId: 'cloze',
        front: '... {{c1::answer}} ...',
        back: 'explain',
        text: '... {{c1::answer}} ...',
        tags: ['k1'],
        images: ['img.png'],
        fields: { Front: 'F', Back: 'B', Text: '... {{c1::answer}} ...' },
        isErrorCard: false,
        createdAt: '2026-02-03T00:00:00.000Z',
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].templateId).toBe('cloze');
    expect(result[0].text).toBe('... {{c1::answer}} ...');
    expect(result[0].images).toEqual(['img.png']);
    expect(result[0].fields).toEqual({ Front: 'F', Back: 'B', Text: '... {{c1::answer}} ...' });
  });

  it('should accept legacy minimal cards and fill required fields', () => {
    const result = normalizeToolExportCards([{ front: 'Front', back: 'Back', tags: ['t1'] }]);

    expect(result).toHaveLength(1);
    expect(result[0].templateId).toBe('basic');
    expect(result[0].front).toBe('Front');
    expect(result[0].back).toBe('Back');
    expect(result[0].fields).toEqual({ Front: 'Front', Back: 'Back' });
    expect(result[0].tags).toEqual(['t1']);
  });
});

