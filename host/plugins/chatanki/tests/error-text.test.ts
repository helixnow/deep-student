import { expect, it } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { errorText } from '../src/execution.ts';
import { validateAgentCardTemplateIds } from '../src/template-selection.ts';
import type { AnkiCard } from '../api.ts';

it('errorText renders AppError like its Rust Display (the message), bare or wrapped in CommandError', () => {
  const appError = AppError.database('获取文档任务失败: disk I/O error');
  expect(errorText(appError)).toBe('获取文档任务失败: disk I/O error');
  expect(errorText(new CommandError(appError))).toBe('获取文档任务失败: disk I/O error');
  expect(errorText(new CommandError('plain command failure'))).toBe('plain command failure');
  expect(errorText(new Error('boom'))).toBe('boom');
  expect(errorText('text')).toBe('text');
  expect(errorText({ message: 'not an AppError' })).toBe('[object Object]');
});

it('validateAgentCardTemplateIds reports an L16 AppError by its message (chatanki_executor.rs:8994–8998)', () => {
  const card = { template_id: 'tpl-a' } as AnkiCard;
  const db = { getCustomTemplateById: () => { throw AppError.database('获取模板失败: database is locked'); } };
  expect(() => validateAgentCardTemplateIds(db, [card])).toThrow(
    'failed to load template tpl-a while validating chatanki_add_cards: 获取模板失败: database is locked; retry later',
  );
});
