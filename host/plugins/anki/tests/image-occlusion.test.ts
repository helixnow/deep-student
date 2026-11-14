import { describe, expect, it } from 'vitest';
import * as io from '../src/image-occlusion.ts';
import type { OcclusionBox, OcclusionSpec } from '../src/image-occlusion.ts';

const box = (x = .1, y = .1, w = .2, h = .2): OcclusionBox => ({ x, y, w, h, label: '测试标签' });
const spec = (boxes: OcclusionBox[], imageRef = 'vfs://images/diagram.png'): OcclusionSpec => ({ imageRef, boxes });
const valid = (s: OcclusionSpec) => {
  const result = io.validateSpec(s);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
};
const issues = (s: OcclusionSpec) => {
  const result = io.validateSpec(s);
  if (result.ok) throw new Error('expected validation failure');
  return result.issues;
};
const codes = (s: OcclusionSpec) => issues(s).map(i => i.code);
const vlm = (boxes: unknown[]) => `[OCCLUSION_BOXES]\n${JSON.stringify(boxes)}\n[/OCCLUSION_BOXES]`;

describe('anki_image_occlusion.rs::tests', () => {
  it('test_reject_empty_boxes', () => expect(codes(spec([]))).toEqual(['empty_boxes']));
  it('test_reject_empty_image_ref', () => expect(codes(spec([box()], '   '))).toEqual(['empty_image_ref']));
  it('test_reject_out_of_bounds', () => {
    for (const b of [box(-.1, .1, .2, .2), box(.9, .1, .2, .2), box(.1, .1, 0, .2)]) {
      expect(codes(spec([b]))).toEqual(['box_out_of_bounds']);
      expect(issues(spec([b]))[0]!.box_index).toBe(0);
    }
    expect(io.validateSpec(spec([box(.8, .8, .2, .2)])).ok).toBe(true);
  });
  it('test_reject_too_small_and_nan', () => {
    expect(codes(spec([box(.1, .1, .005, .2)]))).toEqual(['box_too_small']);
    expect(codes(spec([box(NaN)]))).toEqual(['box_not_finite']);
  });
  it('test_reject_excessive_overlap_but_allow_touching', () => {
    expect(codes(spec([box(.1, .1, .3, .3), box(.15, .15, .3, .3)]))).toEqual(['excessive_overlap']);
    expect(io.validateSpec(spec([box(0, 0, .5, .5), box(.5, 0, .5, .5)])).ok).toBe(true);
  });
  it('test_reject_too_many_boxes_and_zero_cloze_index', () => {
    expect(codes(spec(Array.from({ length: 13 }, (_, i) => box(i % 4 * .25, Math.floor(i / 4) * .25, .1, .1))))).toContain('too_many_boxes');
    expect(codes(spec([{ ...box(), clozeIndex: 0 }]))).toEqual(['cloze_index_zero']);
  });
  it('test_multiple_issues_reported_together', () => {
    const cs = codes(spec([box(.9, .9, .5, .5)], ''));
    expect(cs).toContain('empty_image_ref'); expect(cs).toContain('box_out_of_bounds');
  });
  it('test_auto_assign_cloze_index_and_label', () => {
    const v = valid(spec([{ ...box(0, 0, .3, .3), label: '' }, { ...box(.5, 0, .3, .3), clozeIndex: 5 }, box(0, .5, .3, .3)]));
    expect(v.boxes[0]!.clozeIndex).toBe(6); expect(v.boxes[0]!.label).toBe('区域 6');
    expect(v.boxes[1]!.clozeIndex).toBe(5); expect(v.boxes[2]!.clozeIndex).toBe(7);
  });
  it('test_duplicate_cloze_index_allowed_and_label_truncated', () => {
    const v = valid(spec([{ ...box(0, 0, .3, .3), clozeIndex: 1 }, { ...box(.5, 0, .3, .3), clozeIndex: 1, label: '长'.repeat(100) }]));
    expect(v.boxes.map(b => b.clozeIndex)).toEqual([1, 1]); expect([...v.boxes[1]!.label]).toHaveLength(48);
  });
  it('test_pairwise_iou_values', () => {
    const a = box(.1, .1, .4, .4);
    expect(Math.abs(io.pairwiseIou(a, a) - 1)).toBeLessThan(1e-6);
    expect(io.pairwiseIou(a, box(.6, .6, .2, .2))).toBe(0);
    expect(Math.abs(io.pairwiseIou(a, box(.3, .1, .4, .4)) - 1 / 3)).toBeLessThan(1e-5);
  });
  it('test_to_pixel_boxes_exact_conversion', () => {
    const px = io.toPixelBoxes(valid(spec([box(.25, .5, .5, .25)])), 800, 600);
    expect(px).toHaveLength(1); expect(px[0]).toMatchObject({ x: 200, y: 300, w: 400, h: 150, clozeIndex: 1 });
  });
  it('test_to_pixel_boxes_clamp_and_min_size', () => {
    const v = valid(spec([box(.9, .9, .1, .1), box(.5, .5, .011, .011)]));
    for (const p of io.toPixelBoxes(v, 3, 3)) {
      expect(p.w >= 1 && p.h >= 1).toBe(true); expect(p.x + p.w <= 3 && p.y + p.h <= 3).toBe(true);
    }
    expect(io.toPixelBoxes(v, 0, 100)).toEqual([]);
  });
  it('test_build_card_fields_cloze_text_and_occlusion_json', () => {
    const v = valid(spec([{ ...box(0, 0, .3, .3), label: '左心房' }, { ...box(.5, 0, .3, .3), label: '右心室' }]));
    const fields = io.buildCardFields(v, 'diagram.png', '心脏解剖图');
    expect(fields.text).toBe('<img src="diagram.png"><br>{{c1::左心房}} {{c2::右心室}}');
    expect(fields.extraFields.Extra).toBe('心脏解剖图'); expect(fields.tags).toEqual([io.OCCLUSION_TAG]);
    const parsed = io.parseOcclusionField(fields.extraFields)!;
    expect(parsed.imageRef).toBe('vfs://images/diagram.png'); expect(parsed.boxes).toHaveLength(2);
    expect(parsed.boxes[0]).toMatchObject({ label: '左心房', clozeIndex: 1 });
  });
  it('test_build_card_fields_without_image_and_label_escaping', () => {
    const fields = io.buildCardFields(valid(spec([{ ...box(.1, .1, .3, .3), label: 'A::B}}C' }])));
    expect(fields.text).toBe('{{c1::A：：B} }C}}'); expect(fields.extraFields).not.toHaveProperty('Extra');
  });
  it('test_parse_occlusion_field_invalid_json', () => {
    expect(io.parseOcclusionField({})).toBeNull(); expect(io.parseOcclusionField({ _occlusion: 'not json' })).toBeNull();
  });
  it('test_occlusion_image_ref_from_fields_camel_and_snake_case', () => {
    const fields = io.buildCardFields(valid(spec([box()])));
    expect(io.occlusionImageRefFromFields(fields.extraFields)).toBe('vfs://images/diagram.png');
    expect(io.occlusionImageRefFromFields({ _occlusion: '{"image_ref":"legacy.png","boxes":[]}' })).toBe('legacy.png');
  });
  it('test_occlusion_image_ref_from_fields_missing_or_invalid', () => {
    const fields: Record<string, string>[] = [{}, { _occlusion: 'not json' }, { _occlusion: '{"imageRef":"   ","boxes":[]}' }];
    for (const f of fields) expect(io.occlusionImageRefFromFields(f)).toBeNull();
  });
  it('test_occlusion_image_ref_from_fields_rejects_vlm_pending_placeholder', () => {
    for (const imageRef of ['vlm://pending-image', '  vlm://pending-image  ']) expect(io.occlusionImageRefFromFields({ _occlusion: JSON.stringify({ imageRef, boxes: [] }) })).toBeNull();
    expect(io.occlusionImageRefFromFields({ _occlusion: '{"imageRef":"vfs://images/diagram.png","boxes":[]}' })).toBe('vfs://images/diagram.png');
  });
  it('test_format_anki_io_cloze_normalized_coordinates', () => {
    const v = valid(spec([{ ...box(.1, .2, .3, .15), clozeIndex: 1 }, { ...box(.5, .625, .125, .25), clozeIndex: 2 }]));
    expect(io.formatAnkiIoCloze(v)).toBe('{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.15}}{{c2::image-occlusion:rect:left=.5:top=.625:width=.125:height=.25}}');
  });
  it('test_format_anki_io_cloze_rounds_to_four_decimals_and_trims_zeros', () => {
    expect(io.formatAnkiIoCloze(valid(spec([{ ...box(.3333, 0, .125, .0625), clozeIndex: 7 }])))).toBe('{{c7::image-occlusion:rect:left=.3333:top=0:width=.125:height=.0625}}');
  });
  it('test_parse_vlm_occlusion_boxes_valid_json', () => {
    const s = io.parseOcclusionBoxesFromVlm(vlm([{ ...box(.1, .2, .3, .15), label: '左心房' }]))!;
    expect(s.imageRef).toBe('vlm://pending-image'); expect(s.boxes).toHaveLength(1);
    expect(s.boxes[0]).toMatchObject({ label: '左心房', clozeIndex: 1 });
    expect(Math.abs(s.boxes[0]!.x - .1)).toBeLessThan(1e-6); expect(Math.abs(s.boxes[0]!.h - .15)).toBeLessThan(1e-6);
  });
  it('test_parse_vlm_occlusion_boxes_amid_markdown_and_fence', () => {
    const text = '# 心脏结构\n[IMAGE_DESC: 左心房；右心室]\n\n[OCCLUSION_BOXES]\n```json\n[{"x":0.05,"y":0.1,"w":0.2,"h":0.2,"label":"左心房"},{"x":0.65,"y":0.6,"w":0.2,"h":0.2,"label":"右心室"}]\n```\n[/OCCLUSION_BOXES]\n\n后续 Markdown。';
    const s = io.parseOcclusionBoxesFromVlm(text)!; expect(s.boxes).toHaveLength(2); expect(s.boxes[1]!.label).toBe('右心室');
  });
  it('test_parse_vlm_occlusion_boxes_tolerates_trailing_commas', () => {
    expect(io.parseOcclusionBoxesFromVlm('[OCCLUSION_BOXES]\n[{"x":0.1,"y":0.2,"w":0.3,"h":0.15,"label":"A, B",},]\n[/OCCLUSION_BOXES]')!.boxes[0]!.label).toBe('A, B');
  });
  it('test_parse_vlm_occlusion_boxes_rejects_empty_block', () => expect(io.parseOcclusionBoxesFromVlm('正文\n[OCCLUSION_BOXES]\n\n[/OCCLUSION_BOXES]')).toBeNull());
  it('test_parse_vlm_occlusion_boxes_rejects_malformed_json', () => expect(io.parseOcclusionBoxesFromVlm('[OCCLUSION_BOXES]\n[{x: 0.1}]\n[/OCCLUSION_BOXES]')).toBeNull());
  it('test_parse_vlm_occlusion_boxes_rejects_negative_coordinate', () => expect(io.parseOcclusionBoxesFromVlm(vlm([{ ...box(-.01, .2, .3, .15), label: '越界' }]))).toBeNull());
  it('test_parse_vlm_occlusion_boxes_rejects_extent_past_one', () => expect(io.parseOcclusionBoxesFromVlm(vlm([{ ...box(.8, .2, .3, .15), label: '越界' }]))).toBeNull());
  it('test_parse_vlm_occlusion_boxes_rejects_too_small_box', () => expect(io.parseOcclusionBoxesFromVlm(vlm([{ ...box(.1, .2, .001, .15), label: '过小' }]))).toBeNull());
  it('test_parse_vlm_occlusion_boxes_rejects_excessive_overlap', () => expect(io.parseOcclusionBoxesFromVlm(vlm([{ ...box(.1, .1, .4, .4), label: 'A' }, { ...box(.12, .12, .4, .4), label: 'B' }]))).toBeNull());
  it('test_parse_vlm_occlusion_boxes_rejects_more_than_default_limit', () => {
    const boxes = Array.from({ length: 13 }, (_, i) => ({ ...box(i % 4 * .24, Math.floor(i / 4) * .24, .02, .02), label: `B${i}` }));
    expect(io.parseOcclusionBoxesFromVlm(vlm(boxes))).toBeNull();
  });
  it('test_parse_vlm_occlusion_boxes_uses_later_valid_block', () => {
    const text = vlm([{ ...box(1.1, .2, .3, .15), label: '坏' }]) + '\n' + vlm([{ ...box(.1, .2, .3, .15), label: '好' }]);
    expect(io.parseOcclusionBoxesFromVlm(text)!.boxes[0]!.label).toBe('好');
  });
  it('test_strip_vlm_occlusion_boxes_block_from_markdown', () => {
    const text = '# 标题\n正文\n\n[OCCLUSION_BOXES]\n```json\n[{"x":0.1,"y":0.2,"w":0.3,"h":0.15,"label":"垃圾协议"}]\n```\n[/OCCLUSION_BOXES]\n\n结尾';
    const stripped = io.stripOcclusionBoxesBlocks(text);
    expect(stripped).toBe('# 标题\n正文\n\n\n\n结尾'); expect(stripped).not.toContain('垃圾协议'); expect(stripped).not.toContain(io.OCCLUSION_BOXES_OPEN);
  });
  it('test_strip_vlm_occlusion_boxes_unclosed_block_to_eof', () => expect(io.stripOcclusionBoxesBlocks('保留正文\n[OCCLUSION_BOXES]\n[{"x":0.1')).toBe('保留正文'));
  it('test_build_draft_marker_from_vlm_spec_binds_real_image', () => {
    const s = io.parseOcclusionBoxesFromVlm(vlm([{ ...box(.1, .2, .3, .15), label: '真实框' }]))!;
    s.imageRef = 'image-source-42';
    const fields = io.extractOcclusionDraftFields(io.buildOcclusionDraftMarkerFromSpec(s)!)!;
    const parsed = io.parseOcclusionField(fields.extraFields)!;
    expect(parsed.imageRef).toBe('image-source-42'); expect(Math.abs(parsed.boxes[0]!.x - .1)).toBeLessThan(1e-6); expect(parsed.boxes[0]!.label).toBe('真实框');
  });
  it('test_serde_camel_case_contract', () => {
    const s = io.parseOcclusionField({ _occlusion: '{"imageRef":"vfs://img/1.png","boxes":[{"x":0.1,"y":0.2,"w":0.3,"h":0.4,"label":"标签","clozeIndex":2}]}' })!;
    expect(s.imageRef).toBe('vfs://img/1.png'); expect(s.boxes[0]!.clozeIndex).toBe(2);
    const out = io.serializeOcclusionSpec(s); expect(out).toContain('"imageRef"'); expect(out).toContain('"clozeIndex"'); expect(out).not.toContain('image_ref');
  });
  it('test_propose_boxes_from_image_desc_basic', () => {
    const boxes = io.proposeBoxesFromImageDesc('## 图 1\n[IMAGE_DESC: 心脏血流：右心房 → 右心室；肺动脉；左心房、左心室]', 12);
    expect(boxes.map(b => b.label)).toEqual(['心脏血流', '右心房', '右心室', '肺动脉', '左心房', '左心室']);
    const v = valid(spec(boxes, 'img.png')); expect(v.boxes[0]!.clozeIndex).toBe(1); expect(v.boxes[5]!.clozeIndex).toBe(6);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(io.pairwiseIou(boxes[i]!, boxes[j]!)).toBe(0);
  });
  it('test_propose_boxes_fallback_dedupe_and_caps', () => {
    expect(io.proposeBoxesFromImageDesc('- 线粒体\n- 线粒体\n1. 细胞核。\n2、高尔基体', 2).map(b => b.label)).toEqual(['线粒体', '细胞核']);
    expect(io.proposeBoxesFromImageDesc('', 12)).toEqual([]); expect(io.proposeBoxesFromImageDesc('；；\n- \n1.', 12)).toEqual([]); expect(io.proposeBoxesFromImageDesc('有内容', 0)).toEqual([]);
  });
  it('test_propose_boxes_multiple_image_desc_markers', () => {
    const boxes = io.proposeBoxesFromImageDesc('## 图 1\n[IMAGE_DESC: 输入层；隐藏层]\n## 图 2\n[IMAGE_DESC: 输出层]', 12);
    expect(boxes.map(b => b.label)).toEqual(['输入层', '隐藏层', '输出层']);
    for (const b of boxes) { expect(b.x >= 0 && b.x + b.w <= 1 + 1e-6).toBe(true); expect(b.y >= 0 && b.y + b.h <= 1 + 1e-6).toBe(true); }
  });
  it('test_vlm_draft_marker_round_trip_to_extra_fields_and_strip', () => {
    const marker = io.buildOcclusionDraftMarker('image-source-1', '## 图 1\n[IMAGE_DESC: 输入层；隐藏层；输出层]')!;
    const content = `视觉正文\n${marker}\n后续正文`; const fields = io.extractOcclusionDraftFields(content)!;
    expect(fields.extraFields).toHaveProperty(io.OCCLUSION_FIELD); expect(fields.tags).toEqual([io.OCCLUSION_TAG]);
    const parsed = io.parseOcclusionField(fields.extraFields)!; expect(parsed.imageRef).toBe('image-source-1'); expect(parsed.boxes).toHaveLength(3);
    const stripped = io.stripOcclusionDraftMarkers(content); expect(stripped).toBe('视觉正文\n后续正文'); expect(stripped).not.toContain(io.OCCLUSION_DRAFT_PREFIX);
  });
  it('test_extract_occlusion_draft_fields_uses_image_basename_in_text', () => {
    const fields = io.extractOcclusionDraftFields(io.buildOcclusionDraftMarkerFromSpec(spec([box()], 'vfs://images/heart-anatomy.png'))!)!;
    expect(fields.text.startsWith('<img src="heart-anatomy.png"><br>')).toBe(true); expect(fields.text).toContain('{{c1::测试标签}}');
    expect(io.parseOcclusionField(fields.extraFields)!.imageRef).toBe('vfs://images/heart-anatomy.png');
  });
  it('test_extract_occlusion_draft_fields_basename_handles_backslash_and_plain_ref', () => {
    for (const [ref, expected] of [['C:\\pics\\diagram.png', 'diagram.png'], ['image-source-42', 'image-source-42']] as const) {
      const fields = io.extractOcclusionDraftFields(io.buildOcclusionDraftMarkerFromSpec(spec([box()], ref))!)!;
      expect(fields.text.startsWith(`<img src="${expected}">`)).toBe(true);
    }
  });
  it('test_vlm_draft_marker_invalid_inputs_degrade_to_none', () => {
    expect(io.buildOcclusionDraftMarker('', '[IMAGE_DESC: 输入层；输出层]')).toBeNull(); expect(io.buildOcclusionDraftMarker('image-source-1', '')).toBeNull();
    expect(io.extractOcclusionDraftFields('[ANKI_OCCLUSION_DRAFT:{"imageRef":"x","boxes":[]}]')).toBeNull();
  });
});
