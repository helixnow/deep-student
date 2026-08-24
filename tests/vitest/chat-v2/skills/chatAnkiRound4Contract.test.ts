import { describe, expect, it } from 'vitest';
import { chatAnkiSkill } from '@/features/chat/skills/builtin';

/**
 * ChatAnki Round 4 跨模块契约回归（Round 2–3 新能力的 TS ↔ Rust 同源锁定）。
 *
 * 与 Rust 侧 `src-tauri/tests/anki_ai_native_integration.rs` 成对：
 * - 工具清单：allowlist 与 embeddedTools 用清单 diff 锁定（不写死会过期的数字）；
 * - transform：schema 数值边界与 Rust 引擎常量逐项同源
 *   （ops<=20 / cardIds<=500 / pattern<=1024 / replacement<=4096 /
 *   script code<=65536 / timeout 1000..=120000 默认 30000）；
 * - retemplate：策略 enum 含 fill_missing_llm，Phase 2 契约写进描述；
 * - analyze：routeSource=forced|llm|heuristic 与管线同源，route enum 三处一致；
 * - 工作流纪律：dry_run → 确认 → apply（expectedVersions CAS）不回退。
 */
describe('ChatAnki Round 4 contract', () => {
  const embedded = chatAnkiSkill.embeddedTools ?? [];
  const allowed = chatAnkiSkill.allowedTools ?? [];
  const findTool = (name: string) => embedded.find((tool) => tool.name === name);
  const schemaOf = (name: string) => findTool(name)?.inputSchema as any;

  // --------------------------------------------------------------------
  // 工具清单：allowlist == embedded（清单 diff，不写死过期数字）
  // --------------------------------------------------------------------

  it('keeps the chatanki allowlist and embedded tool set identical (list diff)', () => {
    const allowedChatAnki = allowed
      .filter((name) => name.startsWith('builtin-chatanki_'))
      .sort();
    const embeddedNames = embedded.map((tool) => tool.name).sort();

    // 每个 embedded 工具都必须是 chatanki 前缀（本技能不内嵌他人工具）
    for (const name of embeddedNames) {
      expect(name).toMatch(/^builtin-chatanki_/);
    }

    const missingFromAllowlist = embeddedNames.filter((name) => !allowedChatAnki.includes(name));
    const missingFromEmbedded = allowedChatAnki.filter((name) => !embeddedNames.includes(name));
    expect(missingFromAllowlist).toEqual([]);
    expect(missingFromEmbedded).toEqual([]);
    expect(embeddedNames).toEqual(allowedChatAnki);
  });

  it('rejects duplicate tool names without relying on a tool count', () => {
    const embeddedNames = embedded.map((tool) => tool.name);
    const duplicateEmbedded = embeddedNames.filter(
      (name, index) => embeddedNames.indexOf(name) !== index,
    );
    const duplicateAllowed = allowed.filter((name, index) => allowed.indexOf(name) !== index);

    expect(duplicateEmbedded, 'duplicate names in embeddedTools').toEqual([]);
    expect(duplicateAllowed, 'duplicate names in allowedTools').toEqual([]);
  });

  it('only borrows dependency tools that its declared skill dependencies provide', () => {
    const borrowed = allowed.filter((name) => !name.startsWith('builtin-chatanki_'));
    expect(borrowed.sort()).toEqual(
      ['builtin-ask_user', 'builtin-resource_list', 'builtin-resource_search'].sort(),
    );
    expect(chatAnkiSkill.dependencies).toEqual(
      expect.arrayContaining(['ask-user', 'learning-resource']),
    );
  });

  it('every embedded tool ships a well-formed object input schema', () => {
    for (const tool of embedded) {
      const schema = tool.inputSchema as any;
      expect(schema, tool.name).toBeDefined();
      expect(schema.type, tool.name).toBe('object');
      expect(typeof tool.description, tool.name).toBe('string');
      expect((tool.description ?? '').length, tool.name).toBeGreaterThan(10);
    }
  });

  // --------------------------------------------------------------------
  // transform：schema 边界与 Rust 引擎常量同源
  // --------------------------------------------------------------------

  it('locks transform ops bounds to the Rust engine constants', () => {
    const schema = schemaOf('builtin-chatanki_transform');
    const ops = schema.properties.transform.properties.ops;
    // CHATANKI_TRANSFORM_OPS_LIMIT / CARD_LIMIT / PATTERN_MAX_LEN / REPLACEMENT_MAX_LEN
    expect(ops.maxItems).toBe(20);
    expect(schema.properties.selection.properties.cardIds.maxItems).toBe(500);
    expect(ops.items.properties.pattern.maxLength).toBe(1024);
    expect(ops.items.properties.replacement.maxLength).toBe(4096);
    expect(ops.items.properties.op.enum).toEqual(['regex_replace', 'tag_add', 'tag_remove']);
    expect(ops.items.properties.field.enum).toEqual(['front', 'back', 'text']);
  });

  it('locks transform script bounds to the Rust sandbox constants', () => {
    const script = schemaOf('builtin-chatanki_transform').properties.transform.properties.script;
    // CHATANKI_TRANSFORM_SCRIPT_CODE_MAX_CHARS / TIMEOUT_{MIN,MAX,DEFAULT}_MS
    expect(script.properties.code.maxLength).toBe(65536);
    expect(script.properties.timeoutMs).toMatchObject({
      minimum: 1000,
      maximum: 120000,
      default: 30000,
    });
    expect(script.properties.language.enum).toEqual(['python', 'node']);
    // I/O 合同与安全边界必须写进模型可见的描述
    expect(script.description).toContain('CHATANKI_INPUT');
    expect(script.description).toContain('CHATANKI_OUTPUT');
    expect(script.description).toContain('网络恒禁');
  });

  it('keeps the transform dry_run -> apply CAS discipline in schema and workflow', () => {
    const schema = schemaOf('builtin-chatanki_transform');
    expect(schema.properties.mode).toMatchObject({
      enum: ['dry_run', 'apply'],
      default: 'dry_run',
    });
    expect(schema.properties.expectedVersions.description).toContain('apply 模式必填');
    expect(schema.properties.expectedVersions.description).toContain('expected_versions_mismatch');
    // script 与 ops 互斥（oneOf 二选一）
    expect(schema.properties.transform.oneOf).toEqual([
      { required: ['script'] },
      { required: ['ops'] },
    ]);

    const content = chatAnkiSkill.content ?? '';
    expect(content).toContain('transform(mode=dry_run)');
    expect(content).toContain('expectedVersions=完整映射');
  });

  // --------------------------------------------------------------------
  // retemplate：fill_missing_llm 策略契约
  // --------------------------------------------------------------------

  it('exposes the fill_missing_llm strategy with its phase-2 CAS contract', () => {
    const tool = findTool('builtin-chatanki_retemplate');
    const schema = tool?.inputSchema as any;
    expect(schema.properties.strategy.enum).toEqual([
      'map_only',
      'fill_missing',
      'fill_missing_llm',
    ]);
    // Phase 2 契约：换模板事务之后 LLM 补缺失字段，逐卡 CAS 写回并回报状态
    expect(schema.properties.strategy.description).toContain('fill_missing_llm');
    expect(schema.properties.strategy.description).toContain('CAS 写回');
    expect(schema.properties.strategy.description).toContain('fillStatus');
    expect(tool?.description).toContain('fill_missing_llm');
    // 每张卡都要携带 get_cards 读到的版本
    expect(schema.required).toContain('expectedVersions');
    expect(schema.properties.expectedVersions.minProperties).toBe(1);
    expect(schema.properties.cardIds.maxItems).toBe(100);
  });

  // --------------------------------------------------------------------
  // analyze：routeSource 同源契约
  // --------------------------------------------------------------------

  it('documents the routeSource trichotomy shared with the pipeline', () => {
    const tool = findTool('builtin-chatanki_analyze');
    expect(tool?.description).toContain('routeSource=forced|llm|heuristic');
    expect(tool?.description).toContain('路由决策与制卡管线同源');
    // 低置信度/失败自动回退启发式（与 Rust resolve_route_decision 一致）
    expect(tool?.description).toContain('回退启发式');
    // forced 预演路径
    const schema = tool?.inputSchema as any;
    expect(schema.properties.route.description).toContain('forced');
  });

  it('keeps the route enum identical across run and analyze (start has no route)', () => {
    const routes = ['simple_text', 'vlm_light', 'vlm_full'];
    for (const name of ['builtin-chatanki_run', 'builtin-chatanki_analyze']) {
      const schema = schemaOf(name);
      expect(schema.properties.route.enum, name).toEqual(routes);
    }
    // Rust ChatAnkiStartArgs 没有 route 字段（start 固定纯文本路径），schema 不得虚构该参数
    expect(schemaOf('builtin-chatanki_start').properties.route).toBeUndefined();
  });

  it('limits analyze feedback into run to route and maxCards only', () => {
    const tool = findTool('builtin-chatanki_analyze');
    expect(tool?.description).toContain('只有 route');
    expect(tool?.description).toContain('maxCards（1~100）');
    // 内部预估参数不得伪装成 run/start 参数
    for (const knob of ['temperature', 'segmentOverlapSize', 'maxOutputTokensOverride']) {
      expect(tool?.description).toContain(knob);
      expect(schemaOf('builtin-chatanki_run').properties[knob]).toBeUndefined();
      expect(schemaOf('builtin-chatanki_start').properties[knob]).toBeUndefined();
    }
  });

  // --------------------------------------------------------------------
  // 版本 CAS 契约在卡片写侧工具间保持一致
  // --------------------------------------------------------------------

  it('keeps optimistic-locking versions mandatory across card write tools', () => {
    const updateCard = schemaOf('builtin-chatanki_update_card');
    expect(updateCard.required).toContain('expectedVersion');

    const batchUpdate = schemaOf('builtin-chatanki_batch_update_cards');
    const batchItem = batchUpdate.properties.updates.items;
    expect(batchItem.required).toContain('expectedVersion');

    for (const name of ['builtin-chatanki_retemplate', 'builtin-chatanki_transform']) {
      const schema = schemaOf(name);
      expect(Object.keys(schema.properties), name).toContain('expectedVersions');
    }
  });
});
