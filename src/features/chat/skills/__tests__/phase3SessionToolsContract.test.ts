import { describe, expect, it } from 'vitest';

import { sessionManagerSkill } from '../builtin-tools/session-manager';
import type { ToolSchema } from '../types';

function getTool(name: string): ToolSchema {
  const matches = sessionManagerSkill.embeddedTools?.filter((tool) => tool.name === name) ?? [];
  expect(matches, `${name} must be declared exactly once`).toHaveLength(1);
  return matches[0];
}

describe('phase 3 session tool contracts', () => {
  it('keeps the permission allowlist synchronized with embedded tools', () => {
    const embeddedNames = sessionManagerSkill.embeddedTools?.map((tool) => tool.name) ?? [];

    expect(sessionManagerSkill.allowedTools).toEqual(embeddedNames);
    expect(new Set(embeddedNames).size).toBe(embeddedNames.length);
    expect(embeddedNames).toContain('builtin-session_get_messages');
    expect(embeddedNames).toContain('builtin-session_export');
  });

  it('exposes bounded 1-based message pagination and the supported role filter', () => {
    const tool = getTool('builtin-session_get_messages');

    expect(tool.description).toContain('Low');
    expect(tool.description).toContain('hasMore');
    expect(tool.description).toContain('truncated=true');
    expect(tool.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['session_id', 'page', 'page_size'],
      properties: {
        session_id: { type: 'string', minLength: 1 },
        page: { type: 'integer', minimum: 1, default: 1 },
        page_size: { type: 'integer', minimum: 1, maximum: 20, default: 20 },
        role_filter: { type: 'string', enum: ['user', 'assistant'] },
      },
    });
  });

  it('bounds session discovery to twenty records per page', () => {
    const tool = getTool('builtin-session_list');

    expect(tool.inputSchema).toMatchObject({
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 20 },
        offset: { type: 'integer' },
      },
    });
  });

  it('adds inclusive date bounds to full-text session search', () => {
    const tool = getTool('builtin-session_search');

    expect(tool.description).toContain('updated_at');
    expect(tool.description).toContain('updatedAt');
    expect(tool.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['query'],
      properties: {
        date_from: { type: 'string', minLength: 1 },
        date_to: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
    });
    expect(tool.inputSchema.properties.date_from.description).toContain('YYYY-MM-DD');
    expect(tool.inputSchema.properties.date_to.description).toContain('RFC3339');
  });

  it('matches the backend export modes, range, placement, and return fields', () => {
    const tool = getTool('builtin-session_export');

    expect(tool.description).toContain('Medium');
    expect(tool.description).toContain('messageCount');
    expect(tool.description).toContain('markdown');
    expect(tool.description).toContain('totalChars');
    expect(tool.description).toContain('truncated');
    expect(tool.description).toContain('2000');
    expect(tool.description).toContain('无损写入');
    expect(tool.description).toContain('noteId');
    expect(tool.description).toContain('resourceId');
    expect(tool.description).toContain('path');
    expect(tool.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['session_id', 'format'],
      properties: {
        session_id: { type: 'string', minLength: 1 },
        format: { type: 'string', enum: ['markdown', 'note'] },
        range: {
          type: 'object',
          additionalProperties: false,
          properties: {
            start_message_id: { type: 'string', minLength: 1 },
            end_message_id: { type: 'string', minLength: 1 },
          },
        },
        folder_id: { type: 'string', minLength: 1 },
        title: { type: 'string', minLength: 1, maxLength: 120 },
      },
    });
  });

  it('documents the date-search to full-message summarization workflow truthfully', () => {
    expect(sessionManagerSkill.content).toContain('总结上周问题并保存');
    expect(sessionManagerSkill.content).toMatch(
      /session_search\(query, date_from, date_to\)[\s\S]*session_get_messages\(session_id, page=1, page_size=20, role_filter=user\)[\s\S]*汇总多个会话/,
    );
    expect(sessionManagerSkill.content).toContain('session_export(note) 只导出一个会话的原文');
    expect(sessionManagerSkill.content).toContain('builtin-folder_list 查找目标文件夹');
    expect(sessionManagerSkill.content).toContain('builtin-note_create(content, folder_id, title)');
    expect(sessionManagerSkill.relatedSkills).toEqual([
      'learning-resource',
      'dstu-tools',
      'canvas-note',
    ]);
  });

  it('keeps metadata-only and deliberately unexposed operations explicit', () => {
    const metadata = getTool('builtin-session_get');
    const names = sessionManagerSkill.embeddedTools?.map((tool) => tool.name) ?? [];

    expect(metadata.description).toContain('不返回消息正文');
    expect(sessionManagerSkill.content).toContain('`session_get` 仅返回元数据');
    expect(sessionManagerSkill.content).toContain('不暴露会话硬删除工具');
    expect(sessionManagerSkill.content).toContain('不创建、切换或删除消息变体');
    expect(names).not.toContain('builtin-session_delete');
    expect(names).not.toContain('builtin-session_message_edit');
    expect(names).not.toContain('builtin-session_variant_create');
  });
});
