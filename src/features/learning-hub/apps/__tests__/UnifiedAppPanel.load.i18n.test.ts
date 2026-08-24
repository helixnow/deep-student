/**
 * UnifiedAppPanel 资源加载错误上报 i18n — source 守卫
 *
 * 资源加载失败时的 reportError 上下文（原硬编码「加载资源」）必须走
 * learningHub 命名空间已有的 i18n key（error.loadFailedRetry），
 * 不允许再以中文字面量作为 reportError 的第二个参数。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  path.join(process.cwd(), 'src/features/learning-hub/apps/UnifiedAppPanel.tsx'),
  'utf8'
);

describe('UnifiedAppPanel load-error reporting i18n', () => {
  it('does not pass the hardcoded literal 「加载资源」 as the reportError context', () => {
    expect(source).not.toMatch(/reportError\([^)]*['"`]加载资源['"`]/);
  });

  it('routes the reportError context through the existing learningHub key', () => {
    expect(source).toContain("reportError(result.error, t('error.loadFailedRetry'))");
  });

  it('keeps the learningHub namespace bound so the key resolves', () => {
    expect(source).toContain("useTranslation(['learningHub', 'common'])");
  });
});
