/**
 * choice / form / image schema 与 action-bar followup refine（方案 1.2 / 1.3）
 */
import { describe, it, expect } from 'vitest';
import {
  actionBarPropsSchema,
  choicePropsSchema,
  formFieldSchema,
  formPropsSchema,
  generativeImageSourceSchema,
  imageBlockPropsSchema,
  isAllowedGenerativeImageUrl,
} from '@/features/generative-ui/schema';
import { BUILTIN_GENERATIVE_BLOCK_SCHEMAS } from '@/features/generative-ui/blockSchemas';

const twoOptions = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
];

describe('choicePropsSchema', () => {
  it('applies defaults', () => {
    const r = choicePropsSchema.parse({ question: 'Q?', options: twoOptions });
    expect(r.mode).toBe('single');
    expect(r.allowOther).toBe(false);
    expect(r.required).toBe(true);
  });

  it('accepts multiple with bounds and option images', () => {
    const r = choicePropsSchema.safeParse({
      question: 'Q?',
      mode: 'multiple',
      minSelect: 1,
      maxSelect: 2,
      options: [
        { id: 'a', label: 'A', image: { kind: 'resource', resourceId: 'img_1' } },
        { id: 'b', label: 'B', image: { kind: 'pdf-page', resourceId: 'res_x', page: 3 } },
        { id: 'c-1_', label: 'C' },
      ],
    });
    expect(r.success).toBe(true);
  });

  it.each([
    ['one option', { question: 'Q', options: [{ id: 'a', label: 'A' }] }],
    ['13 options', { question: 'Q', options: Array.from({ length: 13 }, (_, i) => ({ id: `o${i}`, label: 'x' })) }],
    ['empty question', { question: '', options: twoOptions }],
    ['question > 300', { question: 'x'.repeat(301), options: twoOptions }],
    ['duplicate option id', { question: 'Q', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }],
    ['bad option id', { question: 'Q', options: [{ id: 'a b', label: 'A' }, { id: 'b', label: 'B' }] }],
    ['label > 120', { question: 'Q', options: [{ id: 'a', label: 'x'.repeat(121) }, { id: 'b', label: 'B' }] }],
    ['min > max', { question: 'Q', mode: 'multiple', minSelect: 2, maxSelect: 1, options: twoOptions }],
    ['max > options', { question: 'Q', mode: 'multiple', maxSelect: 3, options: twoOptions }],
    ['min > options (default max)', { question: 'Q', mode: 'multiple', minSelect: 3, options: twoOptions }],
    ['bad option image', { question: 'Q', options: [{ id: 'a', label: 'A', image: { kind: 'url', url: 'http://x.com/a.png' } }, { id: 'b', label: 'B' }] }],
  ])('rejects %s', (_name, props) => {
    expect(choicePropsSchema.safeParse(props).success).toBe(false);
  });
});

describe('formPropsSchema / formFieldSchema', () => {
  it('accepts every field kind and applies defaults', () => {
    const r = formPropsSchema.parse({
      title: '偏好',
      fields: [
        { name: 'note', label: '备注', kind: 'text' },
        { name: 'age', label: '年龄', kind: 'number', min: 0, max: 120, unit: '岁' },
        { name: 'mins', label: '分钟', kind: 'slider', min: 0, max: 100 },
        { name: 'stars', label: '评分', kind: 'rating' },
        { name: 'on', label: '提醒', kind: 'switch', default: true },
      ],
    });
    const [text, , slider, rating, sw] = r.fields;
    expect(text).toMatchObject({ kind: 'text', maxLength: 500, required: false });
    expect(slider).toMatchObject({ kind: 'slider', step: 1 });
    expect(rating).toMatchObject({ kind: 'rating', max: 5 });
    expect(sw).toMatchObject({ kind: 'switch', default: true });
  });

  it.each([
    ['bad name', { name: '1abc', label: 'L', kind: 'text' }],
    ['name too long', { name: `a${'b'.repeat(40)}`, label: 'L', kind: 'text' }],
    ['text maxLength > 2000', { name: 'a', label: 'L', kind: 'text', maxLength: 2001 }],
    ['number min > max', { name: 'a', label: 'L', kind: 'number', min: 5, max: 1 }],
    ['slider max <= min', { name: 'a', label: 'L', kind: 'slider', min: 5, max: 5 }],
    ['slider > 1000 steps', { name: 'a', label: 'L', kind: 'slider', min: 0, max: 1001, step: 1 }],
    ['slider step <= 0', { name: 'a', label: 'L', kind: 'slider', min: 0, max: 10, step: 0 }],
    ['rating max 11', { name: 'a', label: 'L', kind: 'rating', max: 11 }],
    ['rating max 2', { name: 'a', label: 'L', kind: 'rating', max: 2 }],
    ['unknown kind', { name: 'a', label: 'L', kind: 'date' }],
    ['label > 80', { name: 'a', label: 'x'.repeat(81), kind: 'switch' }],
  ])('field rejects %s', (_name, field) => {
    expect(formFieldSchema.safeParse(field).success).toBe(false);
  });

  it('slider with exactly 1000 steps passes', () => {
    expect(formFieldSchema.safeParse({ name: 'a', label: 'L', kind: 'slider', min: 0, max: 100, step: 0.1 }).success).toBe(true);
  });

  it('rejects duplicate field names, 0 fields and 13 fields', () => {
    const f = { name: 'a', label: 'L', kind: 'switch' };
    expect(formPropsSchema.safeParse({ fields: [f, f] }).success).toBe(false);
    expect(formPropsSchema.safeParse({ fields: [] }).success).toBe(false);
    expect(
      formPropsSchema.safeParse({
        fields: Array.from({ length: 13 }, (_, i) => ({ ...f, name: `f${i}` })),
      }).success,
    ).toBe(false);
  });
});

describe('image source / imageBlockPropsSchema', () => {
  it.each([
    { kind: 'resource', resourceId: 'att_1' },
    { kind: 'resource', resourceId: 'file_abc-1' },
    { kind: 'resource', resourceId: 'img_x' },
    { kind: 'resource', resourceId: 'res_x' },
    { kind: 'pdf-page', resourceId: 'res_doc', page: 1 },
    { kind: 'pdf-page', resourceId: 'res_doc', page: 10000 },
    { kind: 'url', url: 'https://example.com/a.png' },
    { kind: 'url', url: 'https://cdn.example.org:8443/p/a.webp?x=1' },
  ])('accepts %j', (source) => {
    expect(generativeImageSourceSchema.safeParse(source).success).toBe(true);
  });

  it.each([
    { kind: 'resource', resourceId: 'tb_1' },
    { kind: 'resource', resourceId: 'att_../x' },
    { kind: 'resource', resourceId: 'note_1' },
    { kind: 'pdf-page', resourceId: 'att_1', page: 1 },
    { kind: 'pdf-page', resourceId: 'res_1', page: 0 },
    { kind: 'pdf-page', resourceId: 'res_1', page: 10001 },
    { kind: 'pdf-page', resourceId: 'res_1', page: 1.5 },
    { kind: 'url', url: 'http://example.com/a.png' },
    { kind: 'url', url: 'file:///C:/a.png' },
    { kind: 'url', url: 'https://user:pw@example.com/a.png' },
    { kind: 'url', url: 'https://localhost/a.png' },
    { kind: 'url', url: 'https://foo.localhost/a.png' },
    { kind: 'url', url: 'https://127.0.0.1/a.png' },
    { kind: 'url', url: 'https://0x7f.1/a.png' },
    { kind: 'url', url: 'https://[::1]/a.png' },
    { kind: 'url', url: 'https://intranet/a.png' },
    { kind: 'url', url: 'https://example.com/../a.png' },
    { kind: 'url', url: 'javascript:alert(1)' },
    { kind: 'url', url: `https://example.com/${'a'.repeat(2048)}` },
    { kind: 'svg', url: 'https://example.com/a.svg' },
  ])('rejects %j', (source) => {
    expect(generativeImageSourceSchema.safeParse(source).success).toBe(false);
  });

  it('isAllowedGenerativeImageUrl rejects non-strings', () => {
    expect(isAllowedGenerativeImageUrl(undefined)).toBe(false);
    expect(isAllowedGenerativeImageUrl('')).toBe(false);
    expect(isAllowedGenerativeImageUrl(' https://example.com/a.png')).toBe(false);
  });

  it('image block defaults and alt requirement', () => {
    const r = imageBlockPropsSchema.parse({ source: { kind: 'resource', resourceId: 'img_1' }, alt: '图' });
    expect(r.fit).toBe('contain');
    expect(r.maxHeight).toBe(320);
    expect(imageBlockPropsSchema.safeParse({ source: { kind: 'resource', resourceId: 'img_1' } }).success).toBe(false);
    expect(
      imageBlockPropsSchema.safeParse({ source: { kind: 'resource', resourceId: 'img_1' }, alt: 'x', maxHeight: 100 }).success,
    ).toBe(false);
  });
});

describe('actionBarPropsSchema followup / confirm', () => {
  const followup = (id: string, prompt?: string) => ({ id, label: 'L', ...(prompt === undefined ? {} : { prompt }) });

  it('accepts followup with prompt and plain action without prompt', () => {
    const r = actionBarPropsSchema.safeParse({
      actions: [followup('followup:more-examples', '再给我两个例子'), { id: 'copy-intent', label: '复制' }],
    });
    expect(r.success).toBe(true);
  });

  it.each([
    ['followup without prompt', [followup('followup:x')]],
    ['prompt on non-followup', [followup('copy-intent', 'hi')]],
    ['followup uppercase slug', [followup('followup:Bad', 'p')]],
    ['followup empty slug', [followup('followup:', 'p')]],
    ['followup slug > 40', [followup(`followup:${'a'.repeat(41)}`, 'p')]],
    ['prompt > 500', [followup('followup:x', 'x'.repeat(501))]],
    ['empty prompt', [followup('followup:x', '')]],
    ['5 followups', Array.from({ length: 5 }, (_, i) => followup(`followup:f${i}`, 'p'))],
  ])('rejects %s', (_name, actions) => {
    expect(actionBarPropsSchema.safeParse({ actions }).success).toBe(false);
  });

  it('4 followups pass', () => {
    const actions = Array.from({ length: 4 }, (_, i) => followup(`followup:f${i}`, 'p'));
    expect(actionBarPropsSchema.safeParse({ actions }).success).toBe(true);
  });

  it('confirm=true raises low risk to medium, keeps high', () => {
    const r = actionBarPropsSchema.parse({
      actions: [
        { ...followup('followup:a', 'p'), confirm: true },
        { ...followup('followup:b', 'p'), confirm: true, riskLevel: 'high' },
        followup('followup:c', 'p'),
      ],
    });
    expect(r.actions.map((a) => a.riskLevel)).toEqual(['medium', 'high', 'low']);
    expect(r.actions[0]!.prompt).toBe('p');
  });
});

describe('block schema registration', () => {
  it('registers choice/form/image with allowPartialRender', () => {
    for (const type of ['choice', 'form', 'image']) {
      const config = BUILTIN_GENERATIVE_BLOCK_SCHEMAS.find((c) => c.type === type);
      expect(config, type).toBeDefined();
      expect(config!.allowPartialRender).toBe(true);
    }
  });
});
