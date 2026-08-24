import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * 废弃 MobileHeader 封禁契约（2026-07 移动端审计 → 2026-08 UI/UX 统一）
 *
 * 旧版页面自绘顶栏 MobileHeader 已废弃，文件仅为迁移基线源码测试保留：
 * - layout 公共出口（index.ts）不得再导出它；
 * - 业务代码不得 import layout/MobileHeader，也不得渲染 <MobileHeader>；
 * - data-mobile-shell="header" 打点只允许出现在 UnifiedMobileHeader。
 */

const ROOT = process.cwd();

const readSource = (relPath: string): string =>
  readFileSync(resolve(ROOT, relPath), 'utf-8');

/** 递归列出目录下所有文件，返回相对仓库根的 posix 风格路径 */
const listFiles = (dir: string): string[] => {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        files.push(relative(ROOT, fullPath).split('\\').join('/'));
      }
    }
  };
  walk(resolve(ROOT, dir));
  return files;
};

const CODE_FILE_PATTERN = /\.(ts|tsx|js|jsx)$/;
const STYLE_OR_CODE_FILE_PATTERN = /\.(ts|tsx|js|jsx|css)$/;

/** 仅这两个文件允许引用 layout/MobileHeader：废弃组件本体 + 迁移基线源码测试 */
const BAN_EXEMPT_FILES = new Set([
  'src/components/layout/MobileHeader.tsx',
  'src/components/ui/__tests__/migrationFoundation.source.test.ts',
]);

describe('deprecated MobileHeader ban contract', () => {
  it('keeps the deprecated MobileHeader out of the layout barrel export', () => {
    const layoutIndexSource = readSource('src/components/layout/index.ts');
    expect(layoutIndexSource).not.toContain("from './MobileHeader'");
    // 出口必须仍提供统一顶栏，防止封禁被“连坐清理”误删
    expect(layoutIndexSource).toContain("from './UnifiedMobileHeader'");
  });

  it('bans importing or rendering the deprecated MobileHeader anywhere else in src', () => {
    const violations: string[] = [];

    for (const file of listFiles('src')) {
      if (!CODE_FILE_PATTERN.test(file) || BAN_EXEMPT_FILES.has(file)) continue;
      const source = readSource(file);

      // 模块说明符以 /MobileHeader 结尾（'./MobileHeader'、'@/components/layout/MobileHeader'…）；
      // 结尾紧跟引号，不会误伤 MobileHeaderContext / UnifiedMobileHeader。
      if (/\/MobileHeader['"]/.test(source)) {
        violations.push(`${file}: import 了废弃的 layout/MobileHeader`);
      }

      // JSX 渲染 <MobileHeader ...>；负向前瞻放过 <MobileHeaderProvider>、
      // <MobileHeaderActiveViewSync> 等以 MobileHeader 为前缀的合法组件。
      if (/<MobileHeader(?![A-Za-z0-9_])/.test(source)) {
        violations.push(`${file}: 渲染了废弃的 <MobileHeader>`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('only lets UnifiedMobileHeader stamp data-mobile-shell="header"', () => {
    // (?<!\[) 放过 CSS 属性选择器 [data-mobile-shell='header'] 与注释中的选择器引用，
    // 只捕捉真正往 DOM 上打属性的位置。
    const attributeStamp = /(?<!\[)data-mobile-shell=["']header["']/;

    const stampingFiles = listFiles('src').filter(
      (file) => STYLE_OR_CODE_FILE_PATTERN.test(file) && attributeStamp.test(readSource(file)),
    );

    // 精确等于（而非包含）：既保证唯一来源，也防止统一顶栏丢失打点后测试空转
    expect(stampingFiles).toEqual(['src/components/layout/UnifiedMobileHeader.tsx']);
  });
});
