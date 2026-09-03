import { describe, expect, it } from 'vitest';

import { chatAnkiSkill } from '../builtin';

function analyzeTool() {
  const matches =
    chatAnkiSkill.embeddedTools?.filter((entry) => entry.name === 'builtin-chatanki_analyze') ?? [];
  expect(matches).toHaveLength(1);
  return matches[0];
}

// Round 3 #7：chatanki_analyze 与制卡管线路由同源。
// 本测试钉死「不再永远推荐 simple_text」的调用方契约：schema 暴露
// resourceIds/route，描述必须解释 routeSource 与可回传/自算参数分界。
describe('chatanki_analyze routing contract (Round 3 #7)', () => {
  it('schema accepts text or resource refs plus a forced-route rehearsal', () => {
    const schema = analyzeTool().inputSchema;
    expect(schema.properties.content?.type).toBe('string');
    expect(schema.properties.goal?.type).toBe('string');
    expect(schema.properties.resourceId?.type).toBe('string');
    expect(schema.properties.resourceIds?.type).toBe('array');
    expect(schema.properties.route?.enum).toEqual(['simple_text', 'vlm_light', 'vlm_full']);
    // content 不再是无条件必填：content 或 resourceId(s) 至少其一
    expect(schema.required).toBeUndefined();
    expect(schema.anyOf).toEqual([
      { required: ['content'] },
      { required: ['resourceIds'] },
      { required: ['resourceId'] },
    ]);
  });

  it('description explains routeSource and the pass-back vs pipeline-computed split', () => {
    const description = analyzeTool().description;
    expect(description).toContain('routeSource=forced|llm|heuristic');
    expect(description).toContain('与制卡管线同源');
    // 可回传参数
    expect(description).toContain('maxCards');
    // 管线内自算、不可回传
    expect(description).toContain('temperature/segmentOverlapSize/maxOutputTokensOverride');
    expect(description).not.toContain('永远');
  });

  it('skill content hardwires the curation → generation → QA decision tree', () => {
    const content = chatAnkiSkill.content;
    expect(content).toContain('策展 → 生成 → 质检 决策树');
    // 决策树按序引用工具链
    const route = [
      'builtin-chatanki_analyze',
      'builtin-chatanki_run',
      'builtin-chatanki_wait',
      'builtin-chatanki_get_cards',
      'builtin-chatanki_batch_update_cards',
    ];
    const start = content.indexOf('策展 → 生成 → 质检 决策树');
    expect(start).toBeGreaterThan(-1);
    let cursor = start;
    for (const name of route) {
      const index = content.indexOf(name, cursor + 1);
      expect(index, `${name} should appear inside the decision tree in order`).toBeGreaterThan(
        cursor,
      );
      cursor = index;
    }
    // 自算参数禁止试图回传的纪律写进决策树
    expect(content).toContain('pipelineDefaultMaxCards');
    // Phase 1 子代理档案的降级引用
    expect(content).toContain('content-curator');
    expect(content).toContain('card-qa');
  });
});
