/**
 * SkillsList 图标按钮 aria-label i18n 契约测试
 *
 * 背景：可见 title/文本早已 i18n，但 aria-label 曾是英文硬编码
 * （"favorite" / "enable-skill" / "disable-skill" / "edit" / "more"），
 * 读屏在中文界面会念英文。本测试锁定 aria-label 走既有 i18n key，
 * 防止硬编码字面量回归。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '../SkillsList.tsx'), 'utf8');

const zhSkills = JSON.parse(
  readFileSync(path.join(here, '../../../locales/zh-CN/skills.json'), 'utf8'),
);
const enSkills = JSON.parse(
  readFileSync(path.join(here, '../../../locales/en-US/skills.json'), 'utf8'),
);
const zhCommon = JSON.parse(
  readFileSync(path.join(here, '../../../locales/zh-CN/common.json'), 'utf8'),
);
const enCommon = JSON.parse(
  readFileSync(path.join(here, '../../../locales/en-US/common.json'), 'utf8'),
);

describe('SkillsList icon button aria-label i18n contract', () => {
  it('no longer hardcodes English aria-label literals', () => {
    expect(source).not.toContain('aria-label="favorite"');
    expect(source).not.toContain("'enable-skill'");
    expect(source).not.toContain("'disable-skill'");
    expect(source).not.toContain('aria-label="edit"');
    expect(source).not.toContain('aria-label="more"');
  });

  it('favorite button aria-label switches between skills:favorite.add/remove', () => {
    expect(source).toMatch(
      /aria-label=\{isFavorite\(skill\.id\)\s*\?\s*t\('skills:favorite\.remove'\)\s*:\s*t\('skills:favorite\.add'\)\}/,
    );
  });

  it('enable/disable toggle aria-label reuses skills:package.enable/disable', () => {
    expect(source).toMatch(
      /aria-label=\{\s*isDisabledSkill\s*\?\s*t\('skills:package\.enable'\)\s*:\s*t\('skills:package\.disable'\)\s*\}/,
    );
  });

  it('edit and more buttons aria-label reuse common namespace keys', () => {
    expect(source).toContain("aria-label={t('common:actions.edit')}");
    expect(source).toContain("aria-label={t('common:more')}");
  });

  it('all referenced keys resolve to non-empty strings in zh-CN and en-US', () => {
    for (const locale of [zhSkills, enSkills]) {
      expect(locale.favorite.add).toBeTruthy();
      expect(locale.favorite.remove).toBeTruthy();
      expect(locale.package.enable).toBeTruthy();
      expect(locale.package.disable).toBeTruthy();
    }
    for (const locale of [zhCommon, enCommon]) {
      expect(locale.actions.edit).toBeTruthy();
      expect(locale.more).toBeTruthy();
    }
  });
});
