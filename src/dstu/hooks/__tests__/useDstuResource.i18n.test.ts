import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const hookSource = readFileSync(path.join(here, '../useDstuResource.ts'), 'utf8');
const zhCommon = JSON.parse(
  readFileSync(path.join(here, '../../../locales/zh-CN/common.json'), 'utf8'),
);
const zhDstu = JSON.parse(
  readFileSync(path.join(here, '../../../locales/zh-CN/dstu.json'), 'utf8'),
);

describe('useDstuResource reportError i18n contract', () => {
  it('no longer passes hardcoded English contexts to reportError', () => {
    for (const legacyContext of [
      "'Get content'",
      "'Get resource'",
      "'Save resource'",
      "'Delete resource'",
      "'Create resource'",
      "'Search resource'",
    ]) {
      expect(hookSource).not.toContain(legacyContext);
    }
  });

  it('resolves reportError contexts through existing i18n keys with fallbacks', () => {
    expect(hookSource).toContain("import i18n from '@/i18n'");
    expect(hookSource).toContain(
      "i18n.t('dstu:resource.getResource', { defaultValue: 'Load resource' })",
    );
    expect(hookSource).not.toContain("i18n.t('learningHub:error.loadFailed'");
    expect(hookSource).toContain("i18n.t('common:save', { defaultValue: '保存' })");
    expect(hookSource).toContain("i18n.t('common:delete', { defaultValue: '删除' })");
    expect(hookSource).toContain("i18n.t('common:create', { defaultValue: '新建' })");
    expect(hookSource).toContain("i18n.t('common:search', { defaultValue: '搜索' })");
  });

  it('reuses the existing common locale keys for the other operations', () => {
    expect(zhDstu.resource.getResource).toBe('获取资源');
    expect(zhCommon.save).toBe('保存');
    expect(zhCommon.delete).toBe('删除');
    expect(zhCommon.create).toBe('新建');
    expect(zhCommon.search).toBe('搜索');
  });
});
