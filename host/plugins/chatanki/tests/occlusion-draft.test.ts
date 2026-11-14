import { describe, expect, it } from 'vitest';
import {
  OCCLUSION_DRAFT_PREFIX, extractOcclusionDraftFields, parseOcclusionField,
} from '../../anki/api.ts';
import type { VfsContextRefData, VfsResourceRef } from '../api.ts';
import { appendVlmFullOcclusionDraft } from '../src/occlusion-draft.ts';

function makeRef(type: 'image' | 'file'): VfsResourceRef {
  return {
    sourceId: `src-${type}`, resourceHash: 'hash', type, name: 'ref',
    resourceId: null, snippet: null, injectModes: null,
  };
}

function refData(types: Array<'image' | 'file'>): VfsContextRefData {
  return { refs: types.map(makeRef), truncated: false, totalCount: types.length };
}

describe('chatanki_executor.rs (VlmFull occlusion wiring)', () => {
  it('test_append_vlmfull_occlusion_prefers_grounded_boxes_over_grid', () => {
    const data = refData(['image']);
    const visual = '# 心脏\n[IMAGE_DESC: 网格回退标签一；网格回退标签二]\n[OCCLUSION_BOXES]\n[{"x":0.11,"y":0.22,"w":0.23,"h":0.14,"label":"真实左心房"}]\n[/OCCLUSION_BOXES]';
    const output = appendVlmFullOcclusionDraft(visual, data);
    expect(output).not.toContain('[OCCLUSION_BOXES]');
    const fields = extractOcclusionDraftFields(output);
    expect(fields).not.toBeNull();
    const spec = parseOcclusionField(fields?.extraFields ?? {});
    expect(spec).not.toBeNull();
    expect(spec?.imageRef).toBe(data.refs[0]?.sourceId);
    expect(spec?.boxes).toHaveLength(1);
    expect(spec?.boxes[0]?.label).toBe('真实左心房');
    expect(Math.abs((spec?.boxes[0]?.x ?? 0) - 0.11)).toBeLessThan(1e-6);
    expect(Math.abs((spec?.boxes[0]?.y ?? 0) - 0.22)).toBeLessThan(1e-6);
  });

  it('test_append_vlmfull_occlusion_falls_back_to_grid_on_invalid_coordinates', () => {
    const visual = '[IMAGE_DESC: 输入层；输出层]\n[OCCLUSION_BOXES]\n[{"x":0.9,"y":0.2,"w":0.3,"h":0.2,"label":"越界框"}]\n[/OCCLUSION_BOXES]';
    const output = appendVlmFullOcclusionDraft(visual, refData(['image']));
    expect(output).not.toContain('越界框');
    expect(output).not.toContain('[OCCLUSION_BOXES]');
    const fields = extractOcclusionDraftFields(output);
    expect(fields).not.toBeNull();
    const spec = parseOcclusionField(fields?.extraFields ?? {});
    expect(spec?.boxes.map((box) => box.label)).toEqual(['输入层', '输出层']);
  });

  it('test_append_vlmfull_occlusion_empty_block_falls_back_to_grid', () => {
    const visual = '[IMAGE_DESC: 细胞核；线粒体]\n[OCCLUSION_BOXES]\n\n[/OCCLUSION_BOXES]';
    const output = appendVlmFullOcclusionDraft(visual, refData(['image']));
    const fields = extractOcclusionDraftFields(output);
    expect(fields).not.toBeNull();
    const spec = parseOcclusionField(fields?.extraFields ?? {});
    expect(spec?.boxes).toHaveLength(2);
    expect(spec?.boxes[0]?.label).toBe('细胞核');
    expect(output).not.toContain('[OCCLUSION_BOXES]');
  });

  it('test_append_vlmfull_occlusion_strips_block_without_image_ref', () => {
    const visual = '保留正文\n[OCCLUSION_BOXES]\n[{"x":0.1,"y":0.2,"w":0.3,"h":0.2,"label":"不可见协议"}]\n[/OCCLUSION_BOXES]';
    const output = appendVlmFullOcclusionDraft(visual, refData([]));
    expect(output).toBe('保留正文');
    expect(output).not.toContain(OCCLUSION_DRAFT_PREFIX);
  });

  it('test_append_vlmfull_occlusion_grounded_boxes_work_without_image_desc', () => {
    const visual = '视觉正文\n[OCCLUSION_BOXES]\n[{"x":0.2,"y":0.3,"w":0.2,"h":0.1,"label":"关键节点"}]\n[/OCCLUSION_BOXES]';
    const output = appendVlmFullOcclusionDraft(visual, refData(['image']));
    const fields = extractOcclusionDraftFields(output);
    expect(fields).not.toBeNull();
    const spec = parseOcclusionField(fields?.extraFields ?? {});
    expect(spec?.boxes[0]?.label).toBe('关键节点');
  });
});
