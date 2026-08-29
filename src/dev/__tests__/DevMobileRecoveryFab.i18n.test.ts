import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const componentPath = path.join(repoRoot, 'src/dev/DevMobileRecoveryFab.tsx');
const zhDevPath = path.join(repoRoot, 'src/locales/zh-CN/dev.json');
const enDevPath = path.join(repoRoot, 'src/locales/en-US/dev.json');

describe('DevMobileRecoveryFab aria-label i18n', () => {
  it('source uses the dev namespace key instead of a hardcoded aria-label', () => {
    const source = readFileSync(componentPath, 'utf8');

    expect(source).toContain("useTranslation('dev')");
    expect(source).toContain("t('recovery_fab.aria_label'");
    expect(source).not.toContain('aria-label="开发恢复菜单（可拖动）"');
  });

  it('zh-CN and en-US dev locales define recovery_fab.aria_label', () => {
    const zh = JSON.parse(readFileSync(zhDevPath, 'utf8'));
    const en = JSON.parse(readFileSync(enDevPath, 'utf8'));

    for (const bundle of [zh, en]) {
      expect(typeof bundle?.recovery_fab?.aria_label).toBe('string');
      expect(bundle.recovery_fab.aria_label.length).toBeGreaterThan(0);
    }

    expect(zh.recovery_fab.aria_label).toBe('开发恢复菜单（可拖动）');
  });
});
