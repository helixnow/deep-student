import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(path.join(here, '../CrepeDemoPage.tsx'), 'utf8');
const zhCommon = JSON.parse(
  readFileSync(path.join(here, '../../../locales/zh-CN/common.json'), 'utf8'),
);
const enCommon = JSON.parse(
  readFileSync(path.join(here, '../../../locales/en-US/common.json'), 'utf8'),
);

describe('CrepeDemoPage back button a11y i18n contract', () => {
  it('uses the shared common:back key with a zh fallback for the back aria-label', () => {
    expect(pageSource).toContain("useTranslation");
    expect(pageSource).toContain("aria-label={t('common:back', '返回')}");
  });

  it('does not hardcode the back aria-label in Chinese', () => {
    expect(pageSource).not.toContain('aria-label="返回设置"');
    expect(pageSource).not.toContain('aria-label="返回"');
  });

  it('relies on an existing top-level back key in both locales (no new keys)', () => {
    expect(zhCommon.back).toBe('返回');
    expect(enCommon.back).toBe('Back');
  });
});
