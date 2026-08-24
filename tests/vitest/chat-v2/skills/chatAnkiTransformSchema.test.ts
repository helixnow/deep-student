import { describe, expect, it } from 'vitest';
import { chatAnkiSkill } from '@/features/chat/skills/builtin';

/**
 * builtin-chatanki_transform Schema 契约测试。
 *
 * 对齐 docs/research/anki-ai-native/round1/04-shell-script-integration.md 方案 B/C 组合
 * 与 docs/research/anki-ai-native/round3/01-transform-script.md：
 * - ops 声明式子集（regex_replace / tag_add / tag_remove）：纯 Rust，Medium；
 * - script 沙箱脚本模式（python/node）：Round 3 已生产化，High，网络恒禁，
 *   I/O 走 CHATANKI_INPUT / CHATANKI_OUTPUT 合同；
 * - transform.script 与 transform.ops 互斥（oneOf），必须且只能提供一个。
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
    expect(schema.properties.documentId).toMatchObject({ minLength: 1, pattern: '\\S' });
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

  it('makes script and ops mutually exclusive via oneOf', () => {
    const transform = schema.properties.transform;
    expect(transform.additionalProperties).toBe(false);
    // 二选一：不再有 required: ['ops']，改由 oneOf 强制「必须且只能提供一个」。
    expect(transform.required).toBeUndefined();
    expect(transform.oneOf).toEqual([{ required: ['script'] }, { required: ['ops'] }]);
    expect(Object.keys(transform.properties)).toEqual(['script', 'ops']);
  });

  it('exposes the declarative ops subset unchanged', () => {
    const ops = schema.properties.transform.properties.ops;
    expect(ops).toMatchObject({ type: 'array', minItems: 1, maxItems: 20 });
    expect(ops.items.properties.op.enum).toEqual(['regex_replace', 'tag_add', 'tag_remove']);
    expect(ops.items.required).toEqual(['op']);
    expect(ops.items.additionalProperties).toBe(false);
    expect(ops.items.properties.field.enum).toEqual(['front', 'back', 'text']);
    expect(ops.items.properties.pattern).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 1024,
      pattern: '\\S',
    });
    expect(ops.items.properties.replacement).toMatchObject({ type: 'string', maxLength: 4096 });
    expect(ops.items.properties.tags.items).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 4096,
      pattern: '\\S',
    });
    expect(ops.items.oneOf.map((branch: any) => branch.properties.op.const)).toEqual([
      'regex_replace',
      'tag_add',
      'tag_remove',
    ]);
    expect(ops.items.oneOf.map((branch: any) => branch.required)).toEqual([
      ['op', 'field', 'pattern'],
      ['op', 'tags'],
      ['op', 'tags'],
    ]);
    for (const branch of ops.items.oneOf) {
      expect(branch.additionalProperties).toBe(false);
    }
  });

  it('exposes the sandboxed script mode with required language/code and bounded timeout', () => {
    const script = schema.properties.transform.properties.script;
    expect(script).toBeDefined();
    expect(script.type).toBe('object');
    expect(script.required).toEqual(['language', 'code']);
    expect(script.additionalProperties).toBe(false);
    expect(Object.keys(script.properties)).toEqual(['language', 'code', 'timeoutMs']);
    expect(script.properties.language.enum).toEqual(['python', 'node']);
    expect(script.properties.code).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 65536,
      pattern: '\\S',
    });
    expect(script.properties.timeoutMs).toMatchObject({
      type: 'integer',
      minimum: 1000,
      maximum: 120000,
      default: 30000,
    });
  });

  it('documents the script I/O contract and hard security boundaries', () => {
    const script = schema.properties.transform.properties.script;
    // I/O 合同：环境变量指向输入/输出文件
    expect(script.description).toContain('CHATANKI_INPUT');
    expect(script.description).toContain('CHATANKI_OUTPUT');
    // 关键防线：version 回传无效、空字段拒绝、Cloze 语法校验、未知字段拒绝
    expect(script.description).toContain('version 回传无效');
    expect(script.description).toContain('empty_field');
    expect(script.description).toContain('invalid_cloze_text');
    expect(script.description).toContain('unknown_output_field');
    // 网络恒禁 + job 目录挂载
    expect(script.description).toContain('网络恒禁');
    // 超时语义
    expect(script.properties.timeoutMs.description).toContain('script_timed_out');
  });

  it('documents script sensitivity, v1 no-add/delete rule and platform degradation', () => {
    const description = tool?.description ?? '';
    expect(description).toContain('High');
    expect(description).toContain('审批卡');
    expect(description).toContain('脚本正文');
    expect(description).toContain('禁止脚本新增/删除卡片');
    expect(description).toContain('unknownCardIds');
    expect(description).toContain('script_sandbox_unavailable');
    expect(description).toContain('interpreter_unavailable');
    // version 防篡改：乐观锁只认后端快照记录
    expect(description).toContain('version 一律被忽略');
  });

  it('documents the apply-mode expectedVersions CAS contract', () => {
    const expectedVersions = schema.properties.expectedVersions;
    expect(expectedVersions).toMatchObject({
      type: 'object',
      minProperties: 1,
      additionalProperties: { type: 'string', minLength: 1, pattern: '\\S' },
    });
    expect(expectedVersions.description).toContain('apply 模式必填');
    expect(expectedVersions.description).toContain('expected_versions_mismatch');
    expect(tool?.description).toContain('expectedVersions');
    expect(tool?.description).toContain('dry_run');
    expect(schema.allOf).toEqual([
      {
        if: { properties: { mode: { const: 'apply' } }, required: ['mode'] },
        then: { required: ['expectedVersions'] },
      },
    ]);
  });

  it('makes cardIds/filter exclusive and bounds explicit card IDs', () => {
    const selection = schema.properties.selection;
    expect(selection.properties.cardIds).toMatchObject({
      type: 'array',
      minItems: 1,
      maxItems: 500,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, pattern: '\\S' },
    });
    expect(selection.properties.filter.enum).toEqual(['all', 'edited_only', 'error_only']);
    expect(selection.oneOf).toEqual([{ required: ['cardIds'] }, { required: ['filter'] }]);
    expect(selection.additionalProperties).toBe(false);
  });

  it('keeps the skill content workflow discipline for transform', () => {
    const content = chatAnkiSkill.content ?? '';
    expect(content).toContain('批量程序化变换（chatanki_transform）');
    expect(content).toContain('transform(mode=dry_run)');
    expect(content).toContain('expectedVersions=完整映射');
    // 模式选择纪律：ops 优先，script 走 High 审批
    expect(content).toContain('优先用 ops');
    expect(content).toContain('$CHATANKI_INPUT');
    expect(content).toContain('$CHATANKI_OUTPUT');
    expect(content).toContain('script_sandbox_unavailable');
    expect(content).toContain('回传无效（乐观锁只认后端快照）');
  });
});
