import { describe, expect, it } from 'vitest';
import {
  IMAGE_ANSWER_MAX_IMAGES,
  decodeUserAnswer,
  encodeUserAnswer,
  gradeAnswerLocally,
  parseImageAnswerEnvelope,
  type QuestionImage,
} from '@/api/questionBankApi';

function img(id: string, mime = 'image/jpeg'): QuestionImage {
  return { id, name: `${id}.jpg`, mime, hash: `hash-${id}` };
}

const ENVELOPE = (images: QuestionImage[], text = '') =>
  JSON.stringify({ type: 'image_answer', images, text });

describe('parseImageAnswerEnvelope', () => {
  it('parses a valid envelope with images and text', () => {
    const payload = parseImageAnswerEnvelope(ENVELOPE([img('a'), img('b')], '第三步没写完'));
    expect(payload).not.toBeNull();
    expect(payload!.images).toHaveLength(2);
    expect(payload!.text).toBe('第三步没写完');
  });

  it('accepts an envelope without a text field', () => {
    const payload = parseImageAnswerEnvelope(ENVELOPE([img('a')]));
    expect(payload).not.toBeNull();
    expect(payload!.text).toBe('');
  });

  it('rejects non-JSON, non-envelope JSON, and wrong type tag', () => {
    expect(parseImageAnswerEnvelope('手写答案')).toBeNull();
    expect(parseImageAnswerEnvelope('["a","b"]')).toBeNull();
    expect(parseImageAnswerEnvelope(JSON.stringify({ pairs: [] }))).toBeNull();
    expect(parseImageAnswerEnvelope(JSON.stringify({ type: 'text', images: [img('a')] }))).toBeNull();
  });

  it('rejects empty images or entries failing the mime whitelist / field check', () => {
    expect(parseImageAnswerEnvelope(ENVELOPE([]))).toBeNull();
    expect(
      parseImageAnswerEnvelope(
        JSON.stringify({ type: 'image_answer', images: [{ id: 'a', name: 'a', mime: 'application/pdf', hash: 'h' }] }),
      ),
    ).toBeNull();
    expect(
      parseImageAnswerEnvelope(
        JSON.stringify({ type: 'image_answer', images: [{ id: '', name: 'a', mime: 'image/png', hash: 'h' }] }),
      ),
    ).toBeNull();
    // 混入一个非法元素：整体拒绝，不静默丢弃
    expect(
      parseImageAnswerEnvelope(ENVELOPE([img('a'), { id: 'b', name: 'b', mime: 'video/mp4', hash: 'h' }])),
    ).toBeNull();
  });

  it('rejects more images than the essay-aligned cap', () => {
    const tooMany = Array.from({ length: IMAGE_ANSWER_MAX_IMAGES + 1 }, (_, i) => img(`img${i}`));
    expect(parseImageAnswerEnvelope(ENVELOPE(tooMany))).toBeNull();
    expect(parseImageAnswerEnvelope(ENVELOPE(tooMany.slice(0, IMAGE_ANSWER_MAX_IMAGES)))).not.toBeNull();
  });
});

describe('encodeUserAnswer / decodeUserAnswer with image_answer', () => {
  it('round-trips an image_answer value', () => {
    const encoded = encodeUserAnswer({ type: 'image_answer', images: [img('a'), img('b')], text: '补充' });
    const decoded = decodeUserAnswer('essay', encoded);
    expect(decoded).toEqual({ type: 'image_answer', images: [img('a'), img('b')], text: '补充' });
  });

  it('throws on empty, over-cap, or invalid image lists', () => {
    expect(() => encodeUserAnswer({ type: 'image_answer', images: [], text: '' })).toThrow();
    const tooMany = Array.from({ length: IMAGE_ANSWER_MAX_IMAGES + 1 }, (_, i) => img(`i${i}`));
    expect(() => encodeUserAnswer({ type: 'image_answer', images: tooMany, text: '' })).toThrow();
    expect(() =>
      encodeUserAnswer({
        type: 'image_answer',
        images: [{ id: 'a', name: 'a', mime: 'application/pdf', hash: 'h' }],
        text: '',
      }),
    ).toThrow();
  });

  it('decodes envelopes only on subjective types and falls back to text elsewhere', () => {
    const envelope = ENVELOPE([img('a')], '说明');
    expect(decodeUserAnswer('fill_blank', envelope)?.type).toBe('image_answer');
    expect(decodeUserAnswer('short_answer', envelope)?.type).toBe('image_answer');
    // 数据错位防御：选择题收到信封不构造 image_answer，回退 text 展示原文
    expect(decodeUserAnswer('single_choice', envelope)).toEqual({ type: 'text', value: envelope });
  });
});

describe('gradeAnswerLocally with image_answer', () => {
  it('returns needsManualGrading for envelopes on subjective and fill_blank types', () => {
    const envelope = ENVELOPE([img('a')]);
    for (const questionType of ['short_answer', 'essay', 'calculation', 'proof', 'fill_blank'] as const) {
      const result = gradeAnswerLocally({ question_type: questionType, answer: 'x' }, envelope);
      expect(result).toEqual({ isCorrect: null, needsManualGrading: true });
    }
  });

  it('fill_blank envelope bypasses per-blank structured grading (no false WRONG)', () => {
    const envelope = ENVELOPE([img('a')]);
    const result = gradeAnswerLocally(
      {
        question_type: 'fill_blank',
        structured_data: { blanks: [{ answers: ['答案'], case_sensitive: false, trim: true }] },
      },
      envelope,
    );
    expect(result.isCorrect).toBeNull();
    expect(result.needsManualGrading).toBe(true);
  });
});
