/**
 * `tests/occlusion_export_roundtrip.rs`（11 条）的移植。
 *
 * 覆盖：生成字段 → 入库形状（`_occlusion` + tag）→ APKG/AnkiConnect 转换
 * （IO cloze 语法、`_` 前缀协议字段过滤、媒体文件名解析）。
 * 三个镜像 helper 与 Rust 测试逐字对应，用于交叉校验生产函数。
 */
import { describe, expect, it } from 'vitest';
import {
  OCCLUSION_BOXES_CLOSE,
  OCCLUSION_BOXES_OPEN,
  OCCLUSION_DRAFT_PREFIX,
  OCCLUSION_FIELD,
  OCCLUSION_TAG,
  buildCardFields,
  buildOcclusionDraftMarkerFromSpec,
  defaultOcclusionConfig,
  extractOcclusionDraftFields,
  formatAnkiIoCloze,
  occlusionImageRefFromFields,
  parseOcclusionBoxesFromVlm,
  parseOcclusionField,
  stripOcclusionDraftMarkers,
  validateSpec,
  type OcclusionBox,
  type OcclusionSpec,
  type ValidatedOcclusionSpec,
} from '../api.ts';

function fixtureBox(
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  cloze: number,
): OcclusionBox {
  return { x, y, w, h, label, clozeIndex: cloze };
}

function heartSpec(): OcclusionSpec {
  return {
    imageRef: 'vfs://images/heart-diagram.png',
    boxes: [
      fixtureBox(0.125, 0.25, 0.25, 0.25, '左心房', 1),
      fixtureBox(0.5, 0.5, 0.25, 0.125, '右心室', 2),
    ],
  };
}

function validatedHeart(): ValidatedOcclusionSpec {
  const result = validateSpec(heartSpec(), defaultOcclusionConfig());
  if (!result.ok) throw new Error('fixture 应通过校验');
  return result.value;
}

/** 【镜像】Anki 23.10+ 原生 IO note type 的 Occlusion 字段 cloze 公式。 */
function formatAnkiIoClozeMirror(boxes: readonly OcclusionBox[]): string {
  const coord = (v: number): string => {
    const norm = Math.min(1, Math.max(0, v));
    const s = norm.toFixed(4);
    const trimmed = s.replace(/0+$/, '').replace(/\.$/, '');
    return trimmed.startsWith('0.') ? `.${trimmed.slice(2)}` : trimmed;
  };
  return boxes
    .map(
      (box) =>
        `{{c${box.clozeIndex ?? 1}::image-occlusion:rect:left=${coord(box.x)}:top=${coord(box.y)}:width=${coord(box.w)}:height=${coord(box.h)}}}`,
    )
    .join('');
}

/** 【镜像】导出过滤谓词：`_` 前缀 = 机器协议字段，不得导出。 */
function isInternalProtocolFieldMirror(key: string): boolean {
  return key.startsWith('_');
}

/** 【镜像】`image_ref` → 包内媒体文件名的最小解析约定。 */
function mediaFileNameFromImageRefMirror(imageRef: string): string | null {
  const name = imageRef.split(/[/\\]/u).at(-1)?.trim() ?? '';
  return name === '' ? null : name;
}

describe('tests/occlusion_export_roundtrip.rs', () => {
  it('test_build_card_fields_produces_text_cloze_occlusion_field_and_tag', () => {
    const validated = validatedHeart();
    const fields = buildCardFields(validated, 'heart-diagram.png', '心脏解剖图');

    expect(fields.text).toBe('<img src="heart-diagram.png"><br>{{c1::左心房}} {{c2::右心室}}');
    const occlusionJson = fields.extraFields[OCCLUSION_FIELD];
    expect(occlusionJson).toBeDefined();
    expect(occlusionJson).toContain('"imageRef"');
    expect(fields.extraFields.Extra).toBe('心脏解剖图');
    expect(fields.tags).toEqual([OCCLUSION_TAG]);
    expect(OCCLUSION_FIELD).toBe('_occlusion');
    expect(OCCLUSION_TAG).toBe('image-occlusion');
  });

  it('test_parse_occlusion_field_roundtrip_preserves_coordinates', () => {
    const source = heartSpec();
    const validated = validatedHeart();
    const fields = buildCardFields(validated, 'heart-diagram.png', null);

    const parsed = parseOcclusionField(fields.extraFields);
    expect(parsed).not.toBeNull();
    expect(parsed!.imageRef).toBe(source.imageRef);
    expect(parsed!.boxes).toHaveLength(source.boxes.length);
    parsed!.boxes.forEach((got, index) => {
      const want = source.boxes[index]!;
      expect(got.x, `盒 #${index} x 坐标 roundtrip 漂移`).toBe(want.x);
      expect(got.y, `盒 #${index} y 坐标 roundtrip 漂移`).toBe(want.y);
      expect(got.w, `盒 #${index} w 坐标 roundtrip 漂移`).toBe(want.w);
      expect(got.h, `盒 #${index} h 坐标 roundtrip 漂移`).toBe(want.h);
      expect(got.clozeIndex ?? null, `盒 #${index} cloze 序号漂移`).toBe(want.clozeIndex ?? null);
      expect(got.label, `盒 #${index} 标签漂移`).toBe(want.label);
    });
  });

  it('test_io_cloze_syntax_contains_image_occlusion_rect_with_normalized_coords', () => {
    const validated = validatedHeart();
    const rendered = formatAnkiIoCloze(validated);

    expect(rendered).toContain('image-occlusion:rect');
    expect(rendered.startsWith('{{c1::')).toBe(true);
    expect(rendered.endsWith('}}')).toBe(true);
    expect(rendered).toContain('{{c2::image-occlusion:rect:');
    expect(rendered).toBe(
      '{{c1::image-occlusion:rect:left=.125:top=.25:width=.25:height=.25}}' +
        '{{c2::image-occlusion:rect:left=.5:top=.5:width=.25:height=.125}}',
    );
    expect(rendered).toBe(formatAnkiIoClozeMirror(validated.boxes));

    for (const box of validated.boxes) {
      for (const [name, value] of [
        ['left', box.x],
        ['top', box.y],
        ['width', box.w],
        ['height', box.h],
      ] as const) {
        expect(value, `${name} 归一化坐标越界：${value}`).toBeGreaterThanOrEqual(0);
        expect(value, `${name} 归一化坐标越界：${value}`).toBeLessThanOrEqual(1);
      }
    }
    expect(rendered.includes('left=12.5')).toBe(false);
    expect(rendered.includes('top=25')).toBe(false);
  });

  it('test_export_fields_filter_excludes_underscore_protocol_fields', () => {
    const validated = validatedHeart();
    const cardFields = buildCardFields(validated, 'heart-diagram.png', '提示');

    const noteFields: Record<string, string> = {
      ...cardFields.extraFields,
      Text: cardFields.text,
      _qa_flags: '{"qaPass":true,"codes":[]}',
      _original_generation: '{"front":"原始生成快照"}',
    };
    expect(Object.hasOwn(noteFields, OCCLUSION_FIELD)).toBe(true);

    const exported = Object.keys(noteFields).filter((key) => !isInternalProtocolFieldMirror(key));
    for (const protocolKey of [OCCLUSION_FIELD, '_qa_flags', '_original_generation']) {
      expect(exported.includes(protocolKey), `导出产物泄漏协议字段 ${protocolKey}`).toBe(false);
    }
    expect(exported.every((key) => !key.startsWith('_'))).toBe(true);
    expect(exported.includes('Text')).toBe(true);
    expect(exported.includes('Extra')).toBe(true);
  });

  it('test_legacy_card_without_occlusion_field_skips_conversion', () => {
    const legacyFields: Record<string, string> = {
      Text: '{{c1::线粒体}}是细胞的能量工厂',
      Extra: '生物学基础',
      _qa_flags: '{"qaPass":true,"codes":[]}',
    };
    expect(parseOcclusionField(legacyFields)).toBeNull();

    const corrupted = { ...legacyFields, [OCCLUSION_FIELD]: '{not-json' };
    expect(parseOcclusionField(corrupted)).toBeNull();
    expect(parseOcclusionField({})).toBeNull();
  });

  it('test_image_ref_maps_to_media_file_name', () => {
    for (const [imageRef, want] of [
      ['vfs://images/heart-diagram.png', 'heart-diagram.png'],
      ['/data/media/cell structure.png', 'cell structure.png'],
      ['C:\\media\\neuron.png', 'neuron.png'],
      ['plain-name.png', 'plain-name.png'],
    ] as const) {
      expect(mediaFileNameFromImageRefMirror(imageRef), `image_ref=${imageRef}`).toBe(want);
    }

    const validated = validatedHeart();
    const mediaName = mediaFileNameFromImageRefMirror(validated.imageRef);
    expect(mediaName).toBe('heart-diagram.png');
    const fields = buildCardFields(validated, mediaName, null);
    expect(fields.text.startsWith('<img src="heart-diagram.png"><br>')).toBe(true);

    expect(mediaFileNameFromImageRefMirror('')).toBeNull();
    expect(mediaFileNameFromImageRefMirror('   ')).toBeNull();
    expect(mediaFileNameFromImageRefMirror('vfs://images/')).toBeNull();
  });

  it('test_empty_image_ref_and_invalid_spec_do_not_panic', () => {
    const config = defaultOcclusionConfig();

    const emptyRef: OcclusionSpec = {
      imageRef: '   ',
      boxes: [fixtureBox(0.125, 0.25, 0.25, 0.25, '盒', 1)],
    };
    const emptyRefResult = validateSpec(emptyRef, config);
    expect(emptyRefResult.ok).toBe(false);
    if (emptyRefResult.ok) throw new Error('unreachable');
    expect(emptyRefResult.issues.some((issue) => issue.code === 'empty_image_ref')).toBe(true);

    const emptyBoxes: OcclusionSpec = { imageRef: 'vfs://images/x.png', boxes: [] };
    const emptyBoxesResult = validateSpec(emptyBoxes, config);
    expect(emptyBoxesResult.ok).toBe(false);
    if (emptyBoxesResult.ok) throw new Error('unreachable');
    expect(emptyBoxesResult.issues.some((issue) => issue.code === 'empty_boxes')).toBe(true);

    const zeroCloze = fixtureBox(0.5, 0.5, 0.25, 0.25, '零序号', 1);
    zeroCloze.clozeIndex = 0;
    const invalid: OcclusionSpec = {
      imageRef: 'vfs://images/x.png',
      boxes: [
        fixtureBox(Number.NaN, 0.25, 0.25, 0.25, 'NaN 盒', 1),
        fixtureBox(0.875, 0.25, 0.5, 0.25, '越界盒', 2),
        zeroCloze,
      ],
    };
    const invalidResult = validateSpec(invalid, config);
    expect(invalidResult.ok).toBe(false);
    if (invalidResult.ok) throw new Error('unreachable');
    const codes = invalidResult.issues.map((issue) => issue.code);
    expect(codes).toContain('box_not_finite');
    expect(codes).toContain('box_out_of_bounds');
    expect(codes).toContain('cloze_index_zero');

    expect(mediaFileNameFromImageRefMirror('')).toBeNull();
  });

  it('test_ingest_images_wiring_populates_from_occlusion_image_ref', () => {
    const validated = validatedHeart();
    const fields = buildCardFields(validated, 'heart-diagram.png', null);

    const images: string[] = [];
    if (images.length === 0) {
      const imageRef = occlusionImageRefFromFields(fields.extraFields);
      if (imageRef !== null) images.push(imageRef);
    }
    expect(images).toEqual(['vfs://images/heart-diagram.png']);

    const snakeFields: Record<string, string> = {
      [OCCLUSION_FIELD]: '{"image_ref":"legacy-diagram.png","boxes":[]}',
    };
    expect(occlusionImageRefFromFields(snakeFields)).toBe('legacy-diagram.png');
    expect(parseOcclusionField(snakeFields)).toBeNull();

    const legacyFields: Record<string, string> = { Text: '{{c1::线粒体}}' };
    expect(occlusionImageRefFromFields(legacyFields)).toBeNull();

    const blankRef: Record<string, string> = {
      [OCCLUSION_FIELD]: '{"imageRef":"   ","boxes":[]}',
    };
    expect(occlusionImageRefFromFields(blankRef)).toBeNull();
  });

  it('test_vlm_pending_placeholder_image_ref_stays_out_of_images_end_to_end', () => {
    const vlmText = `图中标注了两个心腔。\n${OCCLUSION_BOXES_OPEN}\n\`\`\`json\n[\n  ${JSON.stringify({ x: 0.125, y: 0.25, w: 0.25, h: 0.25, label: '左心房', clozeIndex: 1 })},\n  ${JSON.stringify({ x: 0.5, y: 0.5, w: 0.25, h: 0.125, label: '右心室', clozeIndex: 2 })}\n]\n\`\`\`\n${OCCLUSION_BOXES_CLOSE}\n后续讲解。`;
    const pendingSpec = parseOcclusionBoxesFromVlm(vlmText);
    expect(pendingSpec).not.toBeNull();
    expect(pendingSpec!.imageRef).toBe('vlm://pending-image');

    const marker = buildOcclusionDraftMarkerFromSpec(pendingSpec!, defaultOcclusionConfig());
    expect(marker).not.toBeNull();
    const fields = extractOcclusionDraftFields(marker!);
    expect(fields).not.toBeNull();

    const occlusionJson = fields!.extraFields[OCCLUSION_FIELD];
    expect(occlusionJson).toBeDefined();
    expect(occlusionJson).toContain('vlm://pending-image');
    expect(fields!.tags).toEqual([OCCLUSION_TAG]);
    expect(fields!.text).toContain('{{c1::左心房}}');

    const images: string[] = [];
    if (images.length === 0) {
      const imageRef = occlusionImageRefFromFields(fields!.extraFields);
      if (imageRef !== null) images.push(imageRef);
    }
    expect(images).toEqual([]);

    for (const pendingJson of [
      '{"imageRef":"vlm://pending-image","boxes":[]}',
      '{"imageRef":"  vlm://pending-image  ","boxes":[]}',
      '{"imageRef":"vlm://other-placeholder","boxes":[]}',
    ]) {
      expect(
        occlusionImageRefFromFields({ [OCCLUSION_FIELD]: pendingJson }),
        `vlm:// scheme 必须整体被过滤：${pendingJson}`,
      ).toBeNull();
    }
    expect(
      occlusionImageRefFromFields({
        [OCCLUSION_FIELD]: '{"imageRef":"vfs://images/heart-diagram.png","boxes":[]}',
      }),
    ).toBe('vfs://images/heart-diagram.png');
  });

  it('test_io_cloze_coords_clamped_and_rounded_to_unit_interval', () => {
    const spec: ValidatedOcclusionSpec = {
      imageRef: 'vfs://images/x.png',
      boxes: [
        { x: -0.25, y: 1.5, w: 2.5, h: -1.0, label: '越界盒', clozeIndex: 1 },
        {
          x: Math.fround(1 / 3),
          y: Math.fround(0.6666667),
          w: Math.fround(0.1234567),
          h: 0.25,
          label: '舍入盒',
          clozeIndex: 2,
        },
      ],
    };

    const rendered = formatAnkiIoCloze(spec);
    expect(rendered).toBe(
      '{{c1::image-occlusion:rect:left=0:top=1:width=1:height=0}}' +
        '{{c2::image-occlusion:rect:left=.3333:top=.6667:width=.1235:height=.25}}',
    );
    expect(rendered).toBe(formatAnkiIoClozeMirror(spec.boxes));
    expect(rendered.includes('=150')).toBe(false);
    expect(rendered.includes('=250')).toBe(false);
    expect(rendered.includes('=-')).toBe(false);
  });

  it('test_occlusion_draft_marker_pipeline_end_to_end_to_export_filter', () => {
    const marker = buildOcclusionDraftMarkerFromSpec(heartSpec(), defaultOcclusionConfig());
    expect(marker).not.toBeNull();
    expect(marker!.startsWith(OCCLUSION_DRAFT_PREFIX)).toBe(true);
    expect(marker!.endsWith(']')).toBe(true);

    const segment = `正文第一行\n${marker!}\n正文第二行`;
    const modelVisible = stripOcclusionDraftMarkers(segment);
    expect(modelVisible.includes(OCCLUSION_DRAFT_PREFIX)).toBe(false);
    expect(modelVisible).toContain('正文第一行');
    expect(modelVisible).toContain('正文第二行');

    const fields = extractOcclusionDraftFields(segment);
    expect(fields).not.toBeNull();
    expect(fields!.text.startsWith('<img src="heart-diagram.png"><br>')).toBe(true);
    expect(fields!.text).toContain('{{c1::左心房}}');
    expect(fields!.text).toContain('{{c2::右心室}}');
    expect(fields!.tags).toEqual([OCCLUSION_TAG]);

    const parsed = parseOcclusionField(fields!.extraFields);
    const source = heartSpec();
    expect(parsed).not.toBeNull();
    expect(parsed!.imageRef).toBe(source.imageRef);
    expect(parsed!.boxes).toEqual(source.boxes);

    expect(occlusionImageRefFromFields(fields!.extraFields)).toBe('vfs://images/heart-diagram.png');

    const noteFields: Record<string, string> = { ...fields!.extraFields, Text: fields!.text };
    const exported = Object.keys(noteFields).filter((key) => !isInternalProtocolFieldMirror(key));
    expect(exported.every((key) => !key.startsWith('_'))).toBe(true);
    expect(exported.includes(OCCLUSION_FIELD)).toBe(false);
    expect(exported.includes('Text')).toBe(true);
  });
});
