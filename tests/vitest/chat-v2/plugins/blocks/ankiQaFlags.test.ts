/**
 * ChatAnki 质检标记（_qa_flags）与媒体报告（mediaReport）解析单元测试。
 *
 * 契约来源：
 * - src-tauri/src/anki_qa_lint.rs：lint 条目 {code, field, message, severity}，
 *   旧字段规则条目 {field, rule, message}，值为 JSON 数组字符串。
 * - src-tauri/src/apkg_importer_service.rs：mediaReport camelCase 序列化
 *   {declared, imported, skipped, skips: [{reason, count, filenames}], mediaDir}。
 */

import { describe, it, expect } from 'vitest';
import {
  CRITIC_QA_FLAG_CODES,
  QA_FLAGS_FIELD,
  isInternalAnkiField,
  maxFlagSeverity,
  parseCardQaFlags,
  summarizeQaFlags,
} from '@/features/chat/plugins/blocks/components/ankiQaFlags';
import {
  parseAnkiMediaReport,
} from '@/features/chat/plugins/blocks/components/ankiMediaReport';

describe('parseCardQaFlags', () => {
  it('parses lint entries and legacy rule entries from a JSON array string', () => {
    const flags = parseCardQaFlags({
      extra_fields: {
        [QA_FLAGS_FIELD]: JSON.stringify([
          { code: 'front_too_long', field: 'front', message: 'Front is too long', severity: 'warn' },
          { field: 'Question', rule: 'maxLength', message: 'exceeds 120 chars' },
          { code: 'empty_back', field: 'back', message: 'Back is empty', severity: 'error' },
        ]),
      },
    });

    expect(flags).toEqual([
      { code: 'front_too_long', field: 'front', message: 'Front is too long', severity: 'warn' },
      // 旧条目：rule 映射为 code，缺失 severity 归一化为 warn
      { code: 'maxLength', field: 'Question', message: 'exceeds 120 chars', severity: 'warn' },
      { code: 'empty_back', field: 'back', message: 'Back is empty', severity: 'error' },
    ]);
  });

  it('returns empty for missing, blank, or non-array values and skips junk entries', () => {
    expect(parseCardQaFlags({ extra_fields: undefined })).toEqual([]);
    expect(parseCardQaFlags({ extra_fields: {} })).toEqual([]);
    expect(parseCardQaFlags({ extra_fields: { [QA_FLAGS_FIELD]: '  ' } })).toEqual([]);
    expect(parseCardQaFlags({ extra_fields: { [QA_FLAGS_FIELD]: '{"not":"array"}' } })).toEqual([]);
    // 数组里的非对象/空对象条目被跳过，不炸不脏
    expect(
      parseCardQaFlags({
        extra_fields: {
          [QA_FLAGS_FIELD]: JSON.stringify([null, 42, 'str', {}, { code: 'tags_empty', field: 'card', message: 'no tags', severity: 'info' }]),
        },
      }),
    ).toEqual([{ code: 'tags_empty', field: 'card', message: 'no tags', severity: 'info' }]);
  });

  it('wraps an unparseable legacy string as a single legacy_flags_unparsed entry', () => {
    const flags = parseCardQaFlags({
      extra_fields: { [QA_FLAGS_FIELD]: 'not-json-at-all' },
    });
    expect(flags).toEqual([
      { code: 'legacy_flags_unparsed', field: '', message: 'not-json-at-all', severity: 'warn' },
    ]);
  });

  it('supports a raw array value and normalizes unknown severities to warn', () => {
    const flags = parseCardQaFlags({
      extra_fields: {
        [QA_FLAGS_FIELD]: [
          { code: 'answer_leak', field: 'front', message: 'leak', severity: 'CRITICAL' },
          { code: 'mixed_language', field: 'card', message: 'mixed', severity: 'INFO' },
        ] as unknown as string,
      },
    });
    expect(flags.map((f) => f.severity)).toEqual(['warn', 'info']);
  });

  it('recognizes the exact revise and flag audit entries written by the critic', () => {
    const flags = parseCardQaFlags({
      extra_fields: {
        [QA_FLAGS_FIELD]: JSON.stringify([
          {
            code: CRITIC_QA_FLAG_CODES.flagged,
            field: 'card',
            message: 'LLM critic 标记：与另一张卡重复',
            severity: 'warn',
          },
          {
            code: CRITIC_QA_FLAG_CODES.revised,
            field: 'card',
            message: 'LLM critic 修订：答案与源材料矛盾',
            severity: 'info',
          },
        ]),
      },
    });

    expect(flags).toEqual([
      {
        code: 'llm_critic',
        field: 'card',
        message: 'LLM critic 标记：与另一张卡重复',
        severity: 'warn',
      },
      {
        code: 'llm_critic_revised',
        field: 'card',
        message: 'LLM critic 修订：答案与源材料矛盾',
        severity: 'info',
      },
    ]);
  });
});

describe('summarizeQaFlags / maxFlagSeverity', () => {
  it('counts flagged cards, total flags, and the highest severity', () => {
    const summary = summarizeQaFlags([
      { extra_fields: { [QA_FLAGS_FIELD]: JSON.stringify([{ code: 'tags_empty', field: 'card', message: 'm', severity: 'info' }]) } },
      { extra_fields: {} },
      {
        extra_fields: {
          [QA_FLAGS_FIELD]: JSON.stringify([
            { code: 'front_too_long', field: 'front', message: 'm', severity: 'warn' },
            { code: 'empty_back', field: 'back', message: 'm', severity: 'error' },
          ]),
        },
      },
    ]);
    expect(summary).toEqual({ flaggedCardCount: 2, totalFlagCount: 3, maxSeverity: 'error' });
  });

  it('returns null max severity when nothing is flagged', () => {
    expect(summarizeQaFlags([{ extra_fields: {} }])).toEqual({
      flaggedCardCount: 0,
      totalFlagCount: 0,
      maxSeverity: null,
    });
    expect(maxFlagSeverity([])).toBeNull();
    expect(
      maxFlagSeverity([
        { code: 'a', field: '', message: '', severity: 'info' },
        { code: 'b', field: '', message: '', severity: 'warn' },
      ]),
    ).toBe('warn');
  });
});

describe('isInternalAnkiField', () => {
  it('treats underscore-prefixed fields as internal', () => {
    expect(isInternalAnkiField('_qa_flags')).toBe(true);
    expect(isInternalAnkiField(' _qa_flags')).toBe(true);
    expect(isInternalAnkiField('Front')).toBe(false);
    expect(isInternalAnkiField('back')).toBe(false);
    expect(isInternalAnkiField('')).toBe(false);
  });
});

describe('parseAnkiMediaReport', () => {
  it('parses the backend camelCase contract with skips and filenames', () => {
    const report = parseAnkiMediaReport({
      declared: 3,
      imported: 2,
      skipped: 1,
      skips: [{ reason: 'entry_missing', count: 1, filenames: ['gone.png'] }],
      mediaDir: '/tmp/anki_media',
    });
    expect(report).toEqual({
      declared: 3,
      imported: 2,
      skipped: 1,
      skips: [{ reason: 'entry_missing', count: 1, filenames: ['gone.png'] }],
      mediaDir: '/tmp/anki_media',
    });
  });

  it('returns null for missing, non-object, or empty (all-zero) reports', () => {
    expect(parseAnkiMediaReport(undefined)).toBeNull();
    expect(parseAnkiMediaReport(null)).toBeNull();
    expect(parseAnkiMediaReport('nope')).toBeNull();
    expect(parseAnkiMediaReport([])).toBeNull();
    expect(parseAnkiMediaReport({})).toBeNull();
    expect(parseAnkiMediaReport({ declared: 0, imported: 0, skipped: 0, skips: [] })).toBeNull();
  });

  it('keeps a clean all-imported report and drops malformed skip entries', () => {
    const report = parseAnkiMediaReport({
      declared: 2,
      imported: 2,
      skipped: 0,
      skips: [null, { count: 1 }, { reason: '', count: 1 }, { reason: 'io_error', count: 'NaN', filenames: 'not-array' }],
    });
    expect(report).toEqual({
      declared: 2,
      imported: 2,
      skipped: 0,
      skips: [{ reason: 'io_error', count: 0, filenames: [] }],
      mediaDir: undefined,
    });
  });
});
