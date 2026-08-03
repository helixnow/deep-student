import { describe, expect, it } from 'vitest';
import { chatAnkiSkill } from '@/features/chat/skills/builtin';

describe('ChatAnki APKG import contract', () => {
  it('exposes a strict resourceId-or-absolute-path tool schema', () => {
    expect(chatAnkiSkill.allowedTools).toContain('builtin-chatanki_import_apkg');

    const tool = chatAnkiSkill.embeddedTools?.find(
      (candidate) => candidate.name === 'builtin-chatanki_import_apkg',
    );
    expect(tool).toBeTruthy();
    const schema = tool?.inputSchema as any;

    expect(schema.oneOf).toEqual([
      { required: ['resourceId'] },
      { required: ['path'] },
    ]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.resourceId).toMatchObject({ type: 'string', minLength: 1 });
    expect(schema.properties.path).toMatchObject({ type: 'string', minLength: 1 });
    expect(tool?.description).toContain('绝对 path');
    expect(tool?.description).toContain('只能提供一个');
  });

  it('requires import, full readback, repair, verification, and confirmed delivery', () => {
    const content = chatAnkiSkill.content ?? '';

    expect(content).toContain(
      '`builtin-chatanki_import_apkg` -> 用返回的 `documentId` 调用 `builtin-chatanki_get_cards`',
    );
    expect(content).toContain('分页读回全部导入卡片');
    expect(content).toContain('当前聊天会话拥有的新文档');
    expect(content).toContain('每次修改后再次 `builtin-chatanki_get_cards` 复核');
    expect(content).toContain('`importedCards`、`importedTemplates`、`mediaSkipped`');
    expect(content).toContain('只有用户明确要求或确认后才用该 `documentId` 调用 `builtin-chatanki_export`');
    expect(content).toContain('只有用户同意加入复习计划后才调用 `builtin-chatanki_enqueue_review`');
  });
});
