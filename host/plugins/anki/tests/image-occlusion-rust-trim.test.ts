/**
 * X7-L16-OCCLUSION-IMAGE-TRIM / X7-L16-OCCLUSION-LABEL-TRIM：`anki_image_occlusion.rs` 的
 * `str::trim` 去掉 U+0085（NEL），但不去 U+FEFF（BOM）；JS `String#trim` 正好相反。
 * 校验/字段构建与 AnkiConnect 同步用的 `rebuildOcclusionClozeText` 都必须按 Rust 处理。
 */
import { describe, expect, it } from 'vitest';
import { rebuildOcclusionClozeText } from '../src/anki-sync.ts';
import { buildCardFields, occlusionImageRefFromFields, validateSpec } from '../src/image-occlusion.ts';

const NEL = '\u0085';
const BOM = '\uFEFF';
const box = (label: string) => ({ x: 0.1, y: 0.1, w: 0.2, h: 0.2, label });

describe('validate_spec image_ref trim (anki_image_occlusion.rs:219,350)', () => {
  it('NEL-only image_ref is empty_image_ref', () => {
    const result = validateSpec({ imageRef: NEL, boxes: [box('A')] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.map((issue) => issue.code)).toEqual(['empty_image_ref']);
  });

  it('BOM-only image_ref is kept, not treated as blank', () => {
    const result = validateSpec({ imageRef: BOM, boxes: [box('A')] });
    expect(result.ok && result.value.imageRef).toBe(BOM);
  });

  it('surrounding NEL is trimmed from the validated image_ref', () => {
    const result = validateSpec({ imageRef: `${NEL}a.png${NEL}`, boxes: [box('A')] });
    expect(result.ok && result.value.imageRef).toBe('a.png');
  });
});

describe('validate_spec label trim (anki_image_occlusion.rs:332-337)', () => {
  it('NEL-only label falls back to the default numbered label', () => {
    const result = validateSpec({ imageRef: 'a.png', boxes: [box(NEL)] });
    expect(result.ok && result.value.boxes[0]).toMatchObject({ label: '区域 1', clozeIndex: 1 });
    expect(result.ok && buildCardFields(result.value).text).toBe('{{c1::区域 1}}');
  });

  it('BOM-only label is kept as the label', () => {
    const result = validateSpec({ imageRef: 'a.png', boxes: [box(BOM)] });
    expect(result.ok && result.value.boxes[0]!.label).toBe(BOM);
  });
});

describe('build_card_fields image name and extra note (anki_image_occlusion.rs:456-475)', () => {
  const validated = () => {
    const result = validateSpec({ imageRef: 'a.png', boxes: [box('A')] });
    if (!result.ok) throw new Error('fixture must validate');
    return result.value;
  };

  it('NEL-only image name and note are treated as absent', () => {
    const fields = buildCardFields(validated(), NEL, NEL);
    expect(fields.text).toBe('{{c1::A}}');
    expect(fields.extraFields).not.toHaveProperty('Extra');
  });

  it('BOM image name and note are kept', () => {
    const fields = buildCardFields(validated(), BOM, BOM);
    expect(fields.text).toBe(`<img src="${BOM}"><br>{{c1::A}}`);
    expect(fields.extraFields.Extra).toBe(BOM);
  });

  it('AnkiConnect cloze rebuild (rebuild_occlusion_cloze_text) uses the same rules', () => {
    expect(rebuildOcclusionClozeText({ imageRef: NEL, boxes: [box('A')] }, 'a.png')).toBeNull();
    expect(rebuildOcclusionClozeText({ imageRef: 'a.png', boxes: [box(NEL)] }, `${NEL}a.png`))
      .toBe('<img src="a.png"><br>{{c1::区域 1}}');
  });
});

describe('occlusion_image_ref_from_fields trim (anki_image_occlusion.rs:505-512)', () => {
  it('NEL-only ref is absent; BOM ref is kept', () => {
    expect(occlusionImageRefFromFields({ _occlusion: JSON.stringify({ imageRef: NEL, boxes: [] }) })).toBeNull();
    expect(occlusionImageRefFromFields({ _occlusion: JSON.stringify({ imageRef: BOM, boxes: [] }) })).toBe(BOM);
  });
});
