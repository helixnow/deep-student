/**
 * 测试 P2-010: 收藏API调用一致性验证
 *
 * 验证所有适配器都使用统一的 dstu.setFavorite() API
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('P2-010: 收藏API调用一致性验证', () => {
  const adaptersPath = resolve(__dirname, '../../../src/dstu/adapters');

  const adapterFiles = [
    'essayDstuAdapter.ts',
    'translationDstuAdapter.ts',
    'textbookDstuAdapter.ts',
  ];

  it('所有适配器应使用 dstu.setFavorite() 而不是 dstu.setMetadata()', () => {
    for (const file of adapterFiles) {
      const filePath = resolve(adaptersPath, file);
      const content = readFileSync(filePath, 'utf-8');

      // 检查是否存在 toggleFavorite 或 setFavorite 方法
      const hasFavoriteMethod =
        content.includes('toggleFavorite') ||
        content.includes('setFavorite');

      if (hasFavoriteMethod) {
        // 应该使用 dstu.setFavorite()
        const usesSetFavoriteAPI = content.includes('dstu.setFavorite(');
        expect(usesSetFavoriteAPI, `${file} 应该使用 dstu.setFavorite() API`).toBe(true);

        // 不应该在收藏相关代码中使用 dstu.setMetadata({ isFavorite: ... })
        // 注意：这个检查可能有误报，因为 setMetadata 可能用于其他用途
        const lines = content.split('\n');
        let inToggleFavorite = false;
        let lineNumber = 0;

        for (const line of lines) {
          lineNumber++;

          if (line.includes('toggleFavorite') || line.includes('async setFavorite')) {
            inToggleFavorite = true;
          }

          if (inToggleFavorite && line.includes('};')) {
            inToggleFavorite = false;
          }

          // 在 toggleFavorite 方法内部不应该使用 setMetadata
          if (inToggleFavorite && line.includes('dstu.setMetadata') && line.includes('isFavorite')) {
            expect.fail(
              `${file}:${lineNumber} - toggleFavorite方法内部不应该使用 dstu.setMetadata({ isFavorite: ... })`
            );
          }
        }
      }
    }
  });

  it('essayDstuAdapter.ts 的 toggleFavorite 应返回 boolean', () => {
    const filePath = resolve(adaptersPath, 'essayDstuAdapter.ts');
    const content = readFileSync(filePath, 'utf-8');

    // 检查返回类型
    const hasCorrectReturnType = content.includes('Promise<Result<boolean, VfsError>>');
    expect(hasCorrectReturnType, 'toggleFavorite 应返回 Promise<Result<boolean, VfsError>>').toBe(true);

    // 检查返回语句
    const hasCorrectReturn = content.includes('return ok(newFavorite)');
    expect(hasCorrectReturn, 'toggleFavorite 应返回 ok(newFavorite)').toBe(true);
  });

  it('translationDstuAdapter.ts 的 toggleFavorite 应返回 boolean', () => {
    const filePath = resolve(adaptersPath, 'translationDstuAdapter.ts');
    const content = readFileSync(filePath, 'utf-8');

    // 检查返回类型
    const hasCorrectReturnType = content.includes('Promise<Result<boolean, VfsError>>');
    expect(hasCorrectReturnType, 'toggleFavorite 应返回 Promise<Result<boolean, VfsError>>').toBe(true);

    // 检查返回语句
    const hasCorrectReturn = content.includes('return ok(newFavorite)');
    expect(hasCorrectReturn, 'toggleFavorite 应返回 ok(newFavorite)').toBe(true);
  });

  it('textbookDstuAdapter.ts 应使用 dstu.setFavorite()', () => {
    const filePath = resolve(adaptersPath, 'textbookDstuAdapter.ts');
    const content = readFileSync(filePath, 'utf-8');

    const usesSetFavoriteAPI = content.includes('dstu.setFavorite(');
    expect(usesSetFavoriteAPI, 'textbookDstuAdapter 应该使用 dstu.setFavorite() API').toBe(true);
  });
});

describe('P2-010: 日志和错误处理验证', () => {
  const adaptersPath = resolve(__dirname, '../../../src/dstu/adapters');

  it('essayDstuAdapter.ts 的 toggleFavorite 应有正确的日志', () => {
    const filePath = resolve(adaptersPath, 'essayDstuAdapter.ts');
    const content = readFileSync(filePath, 'utf-8');

    // 检查日志前缀
    const hasLogPrefix = content.includes("console.log(LOG_PREFIX, 'toggleFavorite via DSTU:', path)");
    expect(hasLogPrefix, 'toggleFavorite 应有日志输出').toBe(true);

    // 检查错误报告
    const hasErrorReport = content.includes("reportError(getResult.error, 'Get essay session')");
    expect(hasErrorReport, 'toggleFavorite 应有错误报告').toBe(true);
  });

  it('translationDstuAdapter.ts 的 toggleFavorite 应有正确的日志', () => {
    const filePath = resolve(adaptersPath, 'translationDstuAdapter.ts');
    const content = readFileSync(filePath, 'utf-8');

    // 检查日志前缀
    const hasLogPrefix = content.includes("console.log(LOG_PREFIX, 'toggleFavorite via DSTU:', path)");
    expect(hasLogPrefix, 'toggleFavorite 应有日志输出').toBe(true);

    // 检查错误报告
    const hasErrorReport = content.includes("reportError(getResult.error, 'Get translation')");
    expect(hasErrorReport, 'toggleFavorite 应有错误报告').toBe(true);
  });
});
