/**
 * a11y / i18n 防回归：聊天窗「展开沙箱工作台」图标按钮。
 *
 * ChatSessionSurface 的展开按钮 aria-label / title 必须复用 chatV2 命名空间
 * 里已有的 `page.expandSandboxWorkbench`（与 ChatV2Page 对齐），
 * 禁止回退到硬编码中文字面量。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_PATH = path.join(
  process.cwd(),
  'src',
  'features',
  'workbench',
  'apps',
  'chat',
  'ChatSessionSurface.tsx',
);

describe('ChatSessionSurface sandbox expand button a11y i18n', () => {
  const src = fs.readFileSync(SOURCE_PATH, 'utf8');

  it('aria-label 与 title 走已有 i18n key page.expandSandboxWorkbench', () => {
    expect(src).toContain("aria-label={t('page.expandSandboxWorkbench')}");
    expect(src).toContain("title={t('page.expandSandboxWorkbench')}");
  });

  it('useTranslation 绑定 chatV2 命名空间且来自 react-i18next', () => {
    expect(src).toMatch(/import \{ useTranslation \} from 'react-i18next';/);
    expect(src).toContain("useTranslation('chatV2')");
  });

  it('不再出现硬编码字面量「展开沙箱工作台」', () => {
    expect(src).not.toContain('展开沙箱工作台');
  });
});
