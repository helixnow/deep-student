import { describe, expect, it } from 'vitest';
import { templateDesignerSkill } from '@/chat-v2/skills/builtin-tools/template-designer';

describe('templateDesignerSkill definition', () => {
  it('includes strict runtime guidance for template id and version handling', () => {
    expect(templateDesignerSkill.content).toContain('模板 ID 必须来自实时查询');
    expect(templateDesignerSkill.content).toContain('expectedVersion');
    expect(templateDesignerSkill.content).toContain('"expectedVersion": "1.0.0"');
    expect(templateDesignerSkill.content).toContain('禁止使用硬编码模板 ID');
    expect(templateDesignerSkill.content).toContain('工具调用串行执行');
    expect(templateDesignerSkill.content).toContain('preparing 超时');
  });

  it('template_update patch schema requires expectedVersion as string', () => {
    const updateTool = templateDesignerSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-template_update',
    );

    expect(updateTool).toBeDefined();
    const patchSchema = updateTool?.inputSchema.properties.patch;
    expect(patchSchema).toBeDefined();
    expect(patchSchema?.type).toBe('object');

    const patchProperties = patchSchema?.properties;
    expect(patchProperties).toBeDefined();
    expect(patchProperties?.expectedVersion?.type).toBe('string');
    expect(patchSchema?.required).toContain('expectedVersion');
  });

  it('template_list limit schema is integer with boundaries', () => {
    const listTool = templateDesignerSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-template_list',
    );

    expect(listTool).toBeDefined();
    const limit = listTool?.inputSchema.properties.limit;
    expect(limit).toBeDefined();
    expect(limit?.type).toBe('integer');
    expect(limit?.default).toBe(50);
    expect(limit?.minimum).toBe(1);
    expect(limit?.maximum).toBe(200);
  });
});
