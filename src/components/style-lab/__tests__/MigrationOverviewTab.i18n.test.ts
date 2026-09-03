import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const componentPath = path.join(repoRoot, 'src/components/style-lab/MigrationOverviewTab.tsx');
const zhPath = path.join(repoRoot, 'src/locales/zh-CN/migration.json');
const enPath = path.join(repoRoot, 'src/locales/en-US/migration.json');

const source = readFileSync(componentPath, 'utf8');
const zh = JSON.parse(readFileSync(zhPath, 'utf8'));
const en = JSON.parse(readFileSync(enPath, 'utf8'));

function keyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object'
      ? keyPaths(value as Record<string, unknown>, full)
      : [full];
  });
}

describe('MigrationOverviewTab i18n (migration:style_lab.*)', () => {
  it('uses the migration namespace and t() for user-facing copy', () => {
    expect(source).toContain("useTranslation('migration')");

    for (const key of [
      'style_lab.status.converged',
      'style_lab.status.in_progress',
      'style_lab.status.needs_push',
      'style_lab.status.not_started',
      'style_lab.metrics.overall_rate',
      'style_lab.metrics.source_files',
      'style_lab.metrics.important',
      'style_lab.metrics.hardcoded_colors',
      'style_lab.metrics.files_count',
      'style_lab.sections.component_progress',
      'style_lab.sections.css_quality',
      'style_lab.footer.scan_meta',
      'style_lab.footer.refresh_suffix',
    ]) {
      expect(source, `component should reference ${key}`).toContain(`'${key}'`);
    }

    // 页脚时间格式跟随当前语言，而不是写死 zh-CN
    expect(source).toContain('toLocaleString(i18n.language)');
    expect(source).not.toContain("toLocaleString('zh-CN')");
  });

  it('zh-CN keeps the original mainline copy under style_lab', () => {
    expect(zh.style_lab.status).toEqual({
      converged: '已收口',
      in_progress: '进行中',
      needs_push: '需推进',
      not_started: '待启动',
    });
    expect(zh.style_lab.metrics.overall_rate).toBe('总体迁移率');
    expect(zh.style_lab.metrics.source_files).toBe('源码文件');
    expect(zh.style_lab.metrics.hardcoded_colors).toBe('硬编码颜色');
    expect(zh.style_lab.metrics.files_count).toBe('{{count}} 文件');
    expect(zh.style_lab.sections.component_progress).toBe('组件族迁移进度');
    expect(zh.style_lab.sections.css_quality).toBe('CSS 质量指标');
    expect(zh.style_lab.footer.scan_meta).toBe('扫描于 {{time}} · 耗时 {{duration}}ms · 运行');
    expect(zh.style_lab.footer.refresh_suffix).toBe('刷新');
  });

  it('en-US mirrors the style_lab key structure with English copy', () => {
    expect(keyPaths(en.style_lab)).toEqual(keyPaths(zh.style_lab));

    for (const key of keyPaths(en.style_lab)) {
      const value = key.split('.').reduce<unknown>(
        (acc, part) => (acc as Record<string, unknown>)[part],
        en.style_lab,
      );
      expect(typeof value, `${key} should be a string`).toBe('string');
    }

    // 插值占位符两侧一致
    expect(en.style_lab.metrics.files_count).toContain('{{count}}');
    expect(en.style_lab.footer.scan_meta).toContain('{{time}}');
    expect(en.style_lab.footer.scan_meta).toContain('{{duration}}');
  });

  it('does not touch the existing data-migration wizard keys', () => {
    for (const bundle of [zh, en]) {
      for (const key of ['title', 'description', 'status', 'check', 'actions', 'progress', 'steps', 'report', 'confirm', 'toast']) {
        expect(bundle, `wizard key "${key}" should still exist`).toHaveProperty(key);
      }
    }
    expect(zh.status.inProgress).toBe('迁移中');
    expect(zh.toast.checkFailed).toBe('检查状态失败');
  });
});
