import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import zhMcp from '@/locales/zh-CN/mcp.json';
import enMcp from '@/locales/en-US/mcp.json';

const EXAM_KEYS = [
  'listQuestionSets',
  'getQuestionSetDetail',
  'deleteQuestionSet',
  'getQuestionSetSessionDetail',
] as const;

const ATTACHMENT_KEYS = [
  'listAttachments',
  'listImageAttachments',
  'listFileAttachments',
  'getAttachmentDetail',
  'deleteAttachment',
  'createAttachment',
  'updateAttachmentMetadata',
  'getUpdatedAttachment',
  'setAttachmentFavorite',
  'searchAttachments',
  'searchImageAttachments',
  'searchFileAttachments',
] as const;

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

const examSource = readSource('src/dstu/adapters/examDstuAdapter.ts');
const attachmentSource = readSource('src/dstu/adapters/attachmentDstuAdapter.ts');

describe('exam/attachment DSTU adapter i18n contract', () => {
  it('provides dstu_exam keys in both locales with aligned key sets', () => {
    expect(Object.keys(zhMcp.dstu_exam).sort()).toEqual([...EXAM_KEYS].sort());
    expect(Object.keys(enMcp.dstu_exam).sort()).toEqual([...EXAM_KEYS].sort());
    for (const key of EXAM_KEYS) {
      expect(zhMcp.dstu_exam[key]).toBeTruthy();
      expect(enMcp.dstu_exam[key]).toBeTruthy();
    }
  });

  it('provides dstu_attachment keys in both locales with aligned key sets', () => {
    expect(Object.keys(zhMcp.dstu_attachment).sort()).toEqual([...ATTACHMENT_KEYS].sort());
    expect(Object.keys(enMcp.dstu_attachment).sort()).toEqual([...ATTACHMENT_KEYS].sort());
    for (const key of ATTACHMENT_KEYS) {
      expect(zhMcp.dstu_attachment[key]).toBeTruthy();
      expect(enMcp.dstu_attachment[key]).toBeTruthy();
    }
  });

  it('references every locale key from the adapter sources with an en-US defaultValue', () => {
    const pattern =
      /i18next\.t\('mcp:(dstu_exam|dstu_attachment)\.(\w+)',\s*\{\s*defaultValue:\s*'([^']+)'\s*\}\)/g;

    const referenced = new Set<string>();
    for (const source of [examSource, attachmentSource]) {
      for (const match of source.matchAll(pattern)) {
        const [, group, key, defaultValue] = match;
        referenced.add(`${group}.${key}`);
        const en = (enMcp as Record<string, Record<string, string>>)[group][key];
        expect(defaultValue).toBe(en);
      }
    }

    for (const key of EXAM_KEYS) {
      expect(referenced).toContain(`dstu_exam.${key}`);
    }
    for (const key of ATTACHMENT_KEYS) {
      expect(referenced).toContain(`dstu_attachment.${key}`);
    }
  });

  it('does not pass hardcoded English contexts to reportError', () => {
    const hardcodedContext = /reportError\([^,]+,\s*'[A-Za-z][^']*'\)/;
    expect(examSource).not.toMatch(hardcodedContext);
    expect(attachmentSource).not.toMatch(hardcodedContext);
  });

  it('keeps the existing dstu namespace attachmentNotFound message untouched', () => {
    expect(attachmentSource).toContain(
      "i18next.t('dstu:adapters.attachment.attachmentNotFound')"
    );
  });
});
