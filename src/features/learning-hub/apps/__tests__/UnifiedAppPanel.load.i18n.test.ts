/**
 * UnifiedAppPanel 资源加载错误上报 i18n — source 守卫
 *
 * reportError 会自行追加“失败”，因此上下文必须是操作名而非已含“失败”的句子。
 * 资源操作名复用 dstu 命名空间，并保留命名空间延迟加载期间的 defaultValue。
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
    expect(source).not.toMatch(/reportError\(\s*result\.error,\s*['"`]加载资源['"`]/);
  });

  it('uses a failure-free localized operation name as the reportError context', () => {
    expect(source).toContain(
      "reportError(result.error, t('dstu:resource.getResource', { defaultValue: 'Load resource' }))",
    );
    expect(source).not.toContain("reportError(result.error, t('error.loadFailedRetry'))");
  });

  it('keeps the learningHub namespace bound so the key resolves', () => {
    expect(source).toContain("useTranslation(['learningHub', 'common', 'dstu'])");
  });
});
