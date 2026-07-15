import { describe, expect, it } from 'vitest';
import { chatAnkiSkill } from '@/features/chat/skills/builtin';

const requiredTools = [
  'builtin-chatanki_get_cards',
  'builtin-chatanki_update_card',
  'builtin-chatanki_delete_card',
  'builtin-chatanki_add_cards',
  'builtin-chatanki_enqueue_review',
  'builtin-chatanki_review_stats',
  'builtin-chatanki_undo_last_review',
  'builtin-chatanki_set_suspended',
  'builtin-chatanki_list_library_cards',
  'builtin-chatanki_update_library_card',
  'builtin-chatanki_enqueue_library_review',
  'builtin-chatanki_set_library_suspended',
  'builtin-chatanki_undo_library_last_review',
  'builtin-chatanki_delete_library_card',
  'builtin-chatanki_retemplate',
];

describe('ChatAnki agent acceptance loop', () => {
  it('loads the read-only resource discovery tools required by its fallback workflow', () => {
    expect(chatAnkiSkill.dependencies).toContain('learning-resource');
    expect(chatAnkiSkill.relatedSkills).toContain('learning-resource');
    expect(chatAnkiSkill.allowedTools).toEqual(
      expect.arrayContaining(['builtin-resource_list', 'builtin-resource_search']),
    );
  });

  it('exposes every card CRUD tool through both allowlist and embedded schemas', () => {
    const allowedChatAnkiTools = (chatAnkiSkill.allowedTools ?? [])
      .filter((name) => name.startsWith('builtin-chatanki_'));
    const embeddedChatAnkiTools = (chatAnkiSkill.embeddedTools ?? [])
      .filter((tool) => tool.name.startsWith('builtin-chatanki_'));
    expect(allowedChatAnkiTools).toHaveLength(26);
    expect(embeddedChatAnkiTools).toHaveLength(26);
    for (const name of requiredTools) {
      expect(chatAnkiSkill.allowedTools).toContain(name);
      expect(chatAnkiSkill.embeddedTools?.some((tool) => tool.name === name)).toBe(true);
    }
  });

  it('defines the cross-session library scope, CAS tokens, and confirmation thresholds', () => {
    const findTool = (name: string) => chatAnkiSkill.embeddedTools?.find(
      (tool) => tool.name === name,
    );
    const findSchema = (name: string) => findTool(name)?.inputSchema as any;
    const listTool = findTool('builtin-chatanki_list_library_cards');
    const listSchema = findSchema('builtin-chatanki_list_library_cards');
    const updateSchema = findSchema('builtin-chatanki_update_library_card');
    const enqueueSchema = findSchema('builtin-chatanki_enqueue_library_review');
    const suspendSchema = findSchema('builtin-chatanki_set_library_suspended');
    const undoSchema = findSchema('builtin-chatanki_undo_library_last_review');
    const deleteSchema = findSchema('builtin-chatanki_delete_library_card');
    const content = chatAnkiSkill.content ?? '';

    expect(listSchema.additionalProperties).toBe(false);
    expect(listSchema.properties.schedule.enum).toEqual([
      'all',
      'due',
      'not_enqueued',
      'suspended',
      'enqueued',
    ]);
    expect(listSchema.properties.filter.enum).toEqual(['all', 'error_only']);
    expect(listSchema.properties.page).toMatchObject({
      type: 'integer',
      minimum: 1,
      default: 1,
    });
    expect(listSchema.properties.pageSize).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 20,
      default: 20,
    });
    expect(listTool?.description).toContain('2,000 字符截断');

    expect(updateSchema.required).toEqual(['cardId', 'expectedVersion', 'patch']);
    expect(updateSchema.properties.cardId).toMatchObject({ type: 'string', minLength: 1 });
    expect(updateSchema.properties.expectedVersion).toMatchObject({
      type: 'string',
      minLength: 1,
    });
    expect(updateSchema.properties.patch.minProperties).toBe(1);
    expect(updateSchema.properties.patch.properties.text.anyOf).toEqual([
      { type: 'string' },
      { enum: [null] },
    ]);
    expect(updateSchema.properties.patch.additionalProperties).toBe(false);
    expect(updateSchema.additionalProperties).toBe(false);

    expect(enqueueSchema.required).toEqual(['cards']);
    expect(enqueueSchema.properties.cards).toMatchObject({
      type: 'array',
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
    });
    expect(enqueueSchema.properties.cards.items.required).toEqual([
      'cardId',
      'expectedVersion',
    ]);
    expect(enqueueSchema.properties.cards.items.properties.cardId.minLength).toBe(1);
    expect(enqueueSchema.properties.cards.items.properties.expectedVersion.minLength).toBe(1);
    expect(enqueueSchema.properties.cards.items.additionalProperties).toBe(false);
    expect(enqueueSchema.additionalProperties).toBe(false);

    expect(suspendSchema.required).toEqual([
      'cardId',
      'expectedReviewVersion',
      'suspended',
    ]);
    expect(suspendSchema.properties.expectedReviewVersion).toMatchObject({
      type: 'integer',
      minimum: 0,
    });
    expect(suspendSchema.properties.suspended.type).toBe('boolean');
    expect(suspendSchema.additionalProperties).toBe(false);

    expect(undoSchema.required).toEqual([
      'cardId',
      'expectedReviewVersion',
      'expectedLogId',
    ]);
    expect(undoSchema.properties.expectedReviewVersion.minimum).toBe(0);
    expect(undoSchema.properties.expectedLogId).toMatchObject({
      type: 'string',
      minLength: 1,
    });
    expect(undoSchema.additionalProperties).toBe(false);

    expect(deleteSchema.required).toEqual([
      'cardId',
      'expectedVersion',
      'expectedReviewVersion',
    ]);
    expect(deleteSchema.properties.expectedReviewVersion.anyOf).toEqual([
      { type: 'integer', minimum: 0 },
      { enum: [null] },
    ]);
    expect(deleteSchema.additionalProperties).toBe(false);

    expect(content).toContain('完整卡片库（跨会话 library scope）');
    expect(content).toContain('不受当前聊天的 `documentId` 所有权范围限制');
    expect(content).toContain('`version` 只保护卡片内容');
    expect(content).toContain('`reviewState.reviewVersion` 只保护 FSRS 状态');
    expect(content).toContain('所有库级写操作必须使用最近一次 `list_library_cards`');
    expect(content).toContain('`truncated=true` 与 `truncatedFields`');
    expect(content).toContain('不得把截断文本当作完整字段');
    expect(content).toContain('一次修改超过 3 张库卡');
    expect(content).toContain('一次删除超过 3 张库卡必须先 ask_user');
    expect(content).toContain('只有用户明确同意后才调用 `builtin-chatanki_enqueue_library_review`');
    expect(content).toContain('`expectedReviewVersion` 必须显式传 `null`');
    expect(content).toContain('实际评分必须由用户在复习 UI 中完成');
  });

  it('defines the versioned retemplate selector and field-mapping workflow', () => {
    const retemplate = chatAnkiSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-chatanki_retemplate',
    );
    const schema = retemplate?.inputSchema as any;
    const content = chatAnkiSkill.content ?? '';

    expect(schema.required).toEqual(
      expect.arrayContaining(['targetTemplateId', 'strategy', 'expectedVersions']),
    );
    expect(schema.oneOf).toEqual([
      { required: ['documentId'] },
      { required: ['cardIds'] },
    ]);
    expect(schema.anyOf).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.documentId.minLength).toBe(1);
    expect(schema.properties.cardIds).toMatchObject({
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', minLength: 1 },
    });
    expect(schema.properties.targetTemplateId.minLength).toBe(1);
    expect(schema.properties.strategy.enum).toEqual(['map_only', 'fill_missing']);
    expect(schema.properties.expectedVersions).toMatchObject({
      type: 'object',
      minProperties: 1,
      additionalProperties: { type: 'string', minLength: 1 },
    });

    expect(content).toContain('`builtin-chatanki_list_templates` -> `builtin-chatanki_get_cards`');
    expect(content).toContain('收集每张卡的 `cardId -> version`');
    expect(content).toContain('`strategy=map_only`');
    expect(content).toContain('`missingFields`');
    expect(content).toContain('按卡逐一调用 `builtin-chatanki_update_card`');
    expect(content).toContain('`fill_missing` **不会调用 LLM，也不会自动生成字段值**');
    expect(content).toContain('`{{cN::...}}`');
    expect(content).toContain('更换超过 3 张卡');
    expect(content).toContain('覆盖用户已编辑卡片');
    expect(content).toContain('整份 document 换模板');
    expect(content).toContain('禁止使用过期 version');
    expect(content).toContain('重建 `expectedVersions`');
  });

  it('requires pagination, optimistic locking, review, and confirmation safeguards', () => {
    const getCards = chatAnkiSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-chatanki_get_cards',
    );
    const updateCard = chatAnkiSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-chatanki_update_card',
    );
    const deleteCard = chatAnkiSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-chatanki_delete_card',
    );
    const listTemplates = chatAnkiSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-chatanki_list_templates',
    );
    const getSchema = getCards?.inputSchema as any;
    const updateSchema = updateCard?.inputSchema as any;
    const deleteSchema = deleteCard?.inputSchema as any;
    const listTemplatesSchema = listTemplates?.inputSchema as any;
    const addCards = chatAnkiSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-chatanki_add_cards',
    );
    const enqueueReview = chatAnkiSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-chatanki_enqueue_review',
    );
    const reviewStats = chatAnkiSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-chatanki_review_stats',
    );
    const addSchema = addCards?.inputSchema as any;
    const enqueueSchema = enqueueReview?.inputSchema as any;
    const statsSchema = reviewStats?.inputSchema as any;
    const content = chatAnkiSkill.content ?? '';

    expect(getSchema.properties.pageSize.maximum).toBe(50);
    expect(updateSchema.required).toEqual(
      expect.arrayContaining(['cardId', 'patch', 'expectedVersion']),
    );
    expect(deleteSchema.required).toEqual([
      'cardId',
      'expectedVersion',
      'expectedReviewVersion',
    ]);
    expect(deleteSchema.properties.expectedVersion.type).toBe('string');
    expect(deleteSchema.properties.expectedReviewVersion.anyOf).toEqual([
      { type: 'integer', minimum: 0 },
      { enum: [null] },
    ]);
    expect(deleteSchema.additionalProperties).toBe(false);
    expect(listTemplatesSchema.properties.page).toMatchObject({
      type: 'integer',
      minimum: 1,
      default: 1,
    });
    expect(listTemplatesSchema.properties.pageSize).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 50,
      default: 20,
    });
    expect(listTemplatesSchema.additionalProperties).toBe(false);
    expect(updateSchema.properties.patch.minProperties).toBe(1);
    expect(updateSchema.properties.patch.properties.extraFields.additionalProperties.type).toBe('string');
    expect(addSchema.properties.cards.items.anyOf).toEqual([
      { required: ['front', 'back'] },
      { required: ['text'] },
    ]);
    expect(enqueueSchema.properties.cardIds.maxItems).toBe(100);
    expect(enqueueSchema.oneOf).toEqual([
      { required: ['documentId'] },
      { required: ['cardIds'] },
    ]);
    expect(enqueueSchema.anyOf).toBeUndefined();
    expect(statsSchema.additionalProperties).toBe(false);
    expect(content).toContain('分页读回全部卡片');
    expect(content).toContain('事实性错误');
    expect(content).toContain('version_conflict');
    expect(content).toContain('超过 3 张卡');
    expect(content).toContain('禁止整批重跑');
    expect(content).toContain('同时传入 `expectedVersion`');
    expect(content).toContain('删除使用双乐观锁');
    expect(content).toContain('显式 nullable `expectedReviewVersion`');
    expect(content).toContain('任何 `version_conflict` / `review_state_conflict`');
    expect(content).toContain('`total/page/pageSize`');
    expect(content).toContain('不能把前 20 个结果当作完整模板库');
    expect(content).toContain('主动询问是否加入复习计划');
    expect(content).toContain('未得到同意不得自动入队');
    expect(content).toContain('`builtin-chatanki_review_stats`');
    expect(content).toContain('只有用户明确要求或确认后');
  });

  it('uses review-state CAS for undo/suspension and never exposes Agent rating', () => {
    const undo = chatAnkiSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-chatanki_undo_last_review',
    );
    const setSuspended = chatAnkiSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-chatanki_set_suspended',
    );
    const undoSchema = undo?.inputSchema as any;
    const suspendedSchema = setSuspended?.inputSchema as any;
    const content = chatAnkiSkill.content ?? '';

    expect(undoSchema.required).toEqual([
      'cardId',
      'expectedReviewVersion',
      'expectedLogId',
    ]);
    expect(undoSchema.properties.cardId).toMatchObject({ type: 'string', minLength: 1 });
    expect(undoSchema.properties.expectedReviewVersion).toMatchObject({
      type: 'integer',
      minimum: 0,
    });
    expect(undoSchema.properties.expectedLogId).toMatchObject({
      type: 'string',
      minLength: 1,
    });
    expect(undoSchema.additionalProperties).toBe(false);

    expect(suspendedSchema.required).toEqual([
      'cardId',
      'expectedReviewVersion',
      'suspended',
    ]);
    expect(suspendedSchema.properties.expectedReviewVersion).toMatchObject({
      type: 'integer',
      minimum: 0,
    });
    expect(suspendedSchema.properties.suspended.type).toBe('boolean');
    expect(suspendedSchema.additionalProperties).toBe(false);

    const manifestTools = chatAnkiSkill.allowedTools ?? [];
    expect(manifestTools.some((name) => name.includes('rate'))).toBe(false);
    expect(manifestTools.some((name) => name.includes('score'))).toBe(false);
    expect(chatAnkiSkill.embeddedTools?.some((tool) => tool.name.includes('rate'))).toBe(false);
    expect(chatAnkiSkill.embeddedTools?.some((tool) => tool.name.includes('score'))).toBe(false);
    expect(content).toContain('`reviewState=null` 表示尚未入队');
    expect(content).toContain('`latestReview.undoable=true`');
    expect(content).toContain('`reviewVersion` 与 `latestReview.logId`');
    expect(content).toContain('`error=review_state_conflict`');
    expect(content).toContain('Agent 严禁推断或代替用户选择 Again/Hard/Good/Easy');
    expect(content).toContain('ChatAnki 工具清单不开放任何评分工具');
    expect(content).toContain('目标或动作有歧义时先用 `builtin-ask_user`');
  });
});
