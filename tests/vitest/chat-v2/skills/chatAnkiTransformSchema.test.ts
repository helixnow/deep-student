import { describe, expect, it } from 'vitest';
import { chatAnkiSkill } from '@/features/chat/skills/builtin';

/**
 * builtin-chatanki_transform Schema 契约测试（Round 2 骨架）。
 *
 * 对齐 docs/research/anki-ai-native/round1/04-shell-script-integration.md 方案 B/C 组合：
 * v1 只暴露 ops 声明式子集（regex_replace / tag_add / tag_remove），
 * script 沙箱脚本模式后端预留（结构化返回 script_mode_unimplemented），不进 Schema。
 */
describe('ChatAnki transform tool schema', () => {
  const tool = chatAnkiSkill.embeddedTools?.find(
    (candidate) => candidate.name === 'builtin-chatanki_transform',
  );
  const schema = tool?.inputSchema as any;

  it('is registered in embeddedTools and allowedTools', () => {
    expect(tool).toBeDefined();
    expect(chatAnkiSkill.allowedTools).toContain('builtin-chatanki_transform');
  });

  it('requires documentId and transform, and forbids unknown top-level params', () => {
    expect(schema.required).toEqual(['documentId', 'transform']);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual([
      'documentId',
      'selection',
      'mode',
      'transform',
      'expectedVersions',
      'purpose',
    ]);
  });

  it('defaults mode to dry_run and only allows dry_run/apply', () => {
    expect(schema.properties.mode).toMatchObject({
      type: 'string',
      enum: ['dry_run', 'apply'],
      default: 'dry_run',
    });
    expect(schema.properties.mode.description).toContain('必须先 dry_run');
  });

  it('exposes only the implemented declarative ops subset (no script mode)', () => {
    const transform = schema.properties.transform;
    expect(transform.required).toEqual(['ops']);
    expect(transform.additionalProperties).toBe(false);
    // script 模式为后续版本预留：v1 Schema 不暴露，后端结构化拒绝。
    expect(transform.properties.script).toBeUndefined();

    const ops = transform.properties.ops;
    expect(ops).toMatchObject({ type: 'array', minItems: 1, maxItems: 20 });
    expect(ops.items.properties.op.enum).toEqual(['regex_replace', 'tag_add', 'tag_remove']);
    expect(ops.items.required).toEqual(['op']);
    expect(ops.items.additionalProperties).toBe(false);
    expect(ops.items.properties.field.enum).toEqual(['front', 'back', 'text']);
    expect(ops.items.properties.pattern).toMatchObject({ type: 'string', maxLength: 1024 });
    expect(ops.items.properties.replacement).toMatchObject({ type: 'string', maxLength: 4096 });
  });

  it('documents the apply-mode expectedVersions CAS contract', () => {
    const expectedVersions = schema.properties.expectedVersions;
    expect(expectedVersions).toMatchObject({
      type: 'object',
      additionalProperties: { type: 'string' },
    });
    expect(expectedVersions.description).toContain('apply 模式必填');
    expect(expectedVersions.description).toContain('expected_versions_mismatch');
    expect(tool?.description).toContain('expectedVersions');
    expect(tool?.description).toContain('dry_run');
    expect(tool?.description).toContain('script_mode_unimplemented');
  });

  it('bounds the selection to 500 explicit card IDs', () => {
    const selection = schema.properties.selection;
    expect(selection.properties.cardIds).toMatchObject({
      type: 'array',
      minItems: 1,
      maxItems: 500,
    });
    expect(selection.properties.filter.enum).toEqual(['all', 'edited_only', 'error_only']);
    expect(selection.additionalProperties).toBe(false);
  });

  it('keeps the skill content workflow discipline for transform', () => {
    const content = chatAnkiSkill.content ?? '';
    expect(content).toContain('批量程序化变换（chatanki_transform）');
    expect(content).toContain('transform(mode=dry_run)');
    expect(content).toContain('expectedVersions=完整映射');
    expect(content).toContain('script_mode_unimplemented');
  });
});
