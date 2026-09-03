import { describe, expect, it } from 'vitest';

import {
  builtinToolSkills,
  getBuiltinToolSkillById,
  translationToolsSkill,
} from '../builtin-tools';
import type { ToolSchema } from '../types';

function getTool(name: string): ToolSchema {
  const matches = translationToolsSkill.embeddedTools?.filter((tool) => tool.name === name) ?? [];
  expect(matches, `${name} must be exposed exactly once`).toHaveLength(1);
  return matches[0];
}

describe('phase 6 translation tool surface', () => {
  it('registers the translation skill exactly once', () => {
    expect(builtinToolSkills.filter((skill) => skill.id === 'translation-tools')).toHaveLength(1);
    expect(getBuiltinToolSkillById('translation-tools')).toBe(translationToolsSkill);
  });

  it('keeps allowedTools and embeddedTools identical', () => {
    const allowed = [...new Set(translationToolsSkill.allowedTools ?? [])].sort();
    const embedded = (translationToolsSkill.embeddedTools ?? []).map((tool) => tool.name).sort();
    expect(allowed).toEqual(embedded);
    expect(allowed).toEqual([
      'builtin-translate_text',
      'builtin-translation_save',
    ]);
  });

  it('declares a strict bounded translate_text schema', () => {
    const translate = getTool('builtin-translate_text');
    expect(translate.inputSchema).toMatchObject({
      required: ['text', 'source_lang', 'target_lang'],
      additionalProperties: false,
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 500000 },
        source_lang: {
          type: 'string',
          minLength: 1,
          maxLength: 32,
          pattern: '^(?:auto|[A-Za-z]+(?:-[A-Za-z0-9]{1,8})*)$',
        },
        target_lang: {
          type: 'string',
          minLength: 1,
          maxLength: 32,
          pattern: '^(?!auto$)[A-Za-z]+(?:-[A-Za-z0-9]{1,8})*$',
        },
        formality: { enum: ['formal', 'casual'] },
        domain: {
          enum: ['general', 'academic', 'technical', 'literary', 'casual', 'legal', 'medical'],
        },
      },
    });
    expect(translate.description).toContain('Low');
    expect(translationToolsSkill.content).toContain('单段最多 100000');
  });

  it('accepts only strict inline term pairs and never advertises glossary_id', () => {
    const translate = getTool('builtin-translate_text');
    expect(translate.inputSchema.properties.terms).toMatchObject({
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['src', 'dst'],
        properties: {
          src: { type: 'string', minLength: 1, maxLength: 200 },
          dst: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    });
    expect(translate.inputSchema.properties).not.toHaveProperty('glossary_id');
    expect(translationToolsSkill.content).toContain('terms: [{src, dst}]');
    expect(translationToolsSkill.content).toContain('不存在 `glossary_id`');
  });

  it('bounds tool-visible translations and provides an opaque save reference', () => {
    const translate = getTool('builtin-translate_text');
    for (const field of [
      'translation_result_id',
      'translated_preview',
      'translated_truncated',
      'segment_count',
      'expires_in_seconds',
      'translated',
    ]) {
      expect(translate.description).toContain(field);
    }
    expect(translationToolsSkill.content).toMatch(/会话绑定、进程内、有界的短期引用/);
    expect(translationToolsSkill.content).toContain('1800 秒');
    expect(translationToolsSkill.content).toContain('保存成功后引用即被消费');
    expect(translationToolsSkill.content).toContain('应用重启或引用过期后必须重新翻译');
  });

  it('makes result-reference and direct-text save paths mutually exclusive', () => {
    const save = getTool('builtin-translation_save');
    expect(save.inputSchema.additionalProperties).toBe(false);
    expect(save.inputSchema.oneOf).toHaveLength(2);
    expect(save.inputSchema.properties).toMatchObject({
      translation_result_id: { type: 'string', minLength: 1, maxLength: 80 },
      source: { type: 'string', minLength: 1, maxLength: 2000 },
      translated: { type: 'string', minLength: 1, maxLength: 2000 },
      source_lang: { type: 'string', minLength: 1, maxLength: 32 },
      target_lang: { type: 'string', minLength: 1, maxLength: 32 },
      title: { type: 'string', minLength: 1, maxLength: 200 },
      folder_id: { type: 'string', minLength: 1, maxLength: 128 },
      engine: { type: 'string', minLength: 1, maxLength: 200 },
      model: { type: 'string', minLength: 1, maxLength: 200 },
    });
    expect(save.inputSchema.oneOf?.[0]).toMatchObject({
      required: ['translation_result_id'],
      additionalProperties: false,
      properties: {
        translation_result_id: { type: 'string', minLength: 1, maxLength: 80 },
        folder_id: { type: 'string', minLength: 1 },
      },
    });
    expect(save.inputSchema.oneOf?.[0].properties).not.toHaveProperty('source');
    expect(save.inputSchema.oneOf?.[0].properties).not.toHaveProperty('source_lang');
    expect(save.inputSchema.oneOf?.[1]).toMatchObject({
      required: ['source', 'translated', 'source_lang', 'target_lang'],
      additionalProperties: false,
      properties: {
        source: { type: 'string', minLength: 1, maxLength: 2000 },
        translated: { type: 'string', minLength: 1, maxLength: 2000 },
        source_lang: { type: 'string', minLength: 1 },
        target_lang: { type: 'string', minLength: 1 },
      },
    });
    expect(save.description).toContain('Medium');
    expect(save.description).toContain('真实 VFS 翻译资源');
    for (const field of [
      'translation_id',
      'resource_id',
      'path',
      'undo',
      'builtin-dstu_delete',
    ]) {
      expect(save.description).toContain(field);
    }
    expect(save.description).toContain('软删除');
  });

  it('documents translation and persistence as two truthful steps', () => {
    expect(translationToolsSkill.content).toContain('translate_text **不会自动入库**');
    expect(translationToolsSkill.content).toContain('translation_save **不会重新翻译**');
    expect(translationToolsSkill.content).toContain('用户只要求翻译聊天中的一句短文本');
    expect(translationToolsSkill.content).toContain('只有用户明确要求入库时');
    expect(translationToolsSkill.content).toContain('不向无人值守 headless');
    expect(translationToolsSkill.content).toContain('load_skills(["learning-resource"])');
    expect(translationToolsSkill.content).toContain('builtin-resource_read');
    expect(translationToolsSkill.content).toContain('page_start/page_end');
    expect(translationToolsSkill.content).toContain('code/message/message_key/hint/retryable');
    expect(translationToolsSkill.content).toContain('GLOSSARY_ID_UNSUPPORTED');
    expect(translationToolsSkill.content).toContain('TRANSLATION_RESULT_NOT_FOUND');
    for (const code of [
      'INVALID_ARGUMENT',
      'TRANSLATION_CANCELLED',
      'TRANSLATION_RESULT_TOO_LARGE',
      'DEPENDENCY_UNAVAILABLE',
      'TRANSLATION_FAILED',
      'EMPTY_TRANSLATION',
      'FOLDER_NOT_FOUND',
      'TRANSLATION_SAVE_FAILED',
    ]) {
      expect(translationToolsSkill.content).toContain(code);
    }
  });

  it('accepts source auto but rejects target auto at schema level', () => {
    const translate = getTool('builtin-translate_text');
    const sourcePattern = new RegExp(translate.inputSchema.properties.source_lang.pattern ?? '');
    const targetPattern = new RegExp(translate.inputSchema.properties.target_lang.pattern ?? '');
    expect(sourcePattern.test('auto')).toBe(true);
    expect(sourcePattern.test('zh-Hans-CN')).toBe(true);
    expect(targetPattern.test('auto')).toBe(false);
    expect(targetPattern.test('zh-Hans-CN')).toBe(true);
  });
});
