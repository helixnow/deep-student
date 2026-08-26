/**
 * FolderPickerDialog 树节点展开按钮无障碍 — source 守卫
 *
 * 回归防线：展开/收起按钮的 aria-label 曾硬编码英文 "toggle"，
 * 屏幕阅读器用户（尤其非英文 locale）无法得知按钮语义与当前状态。
 * 现约定：
 * - aria-label 使用 common 命名空间既有 key（展开 actions.expand / 收起 actions.collapse），
 *   不新增 locale 词条；
 * - 按钮同时暴露 aria-expanded 反映展开状态。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  path.join(process.cwd(), 'src/features/learning-hub/components/finder/FolderPickerDialog.tsx'),
  'utf8'
);

describe('FolderPickerDialog tree toggle button accessibility', () => {
  it('no longer hardcodes the english "toggle" aria-label', () => {
    expect(source).not.toContain('aria-label="toggle"');
  });

  it('labels the toggle via existing common:actions keys, switching on expansion state', () => {
    expect(source).toContain(
      "aria-label={isExpanded ? t('common:actions.collapse') : t('common:actions.expand')}"
    );
  });

  it('exposes aria-expanded on the toggle button', () => {
    expect(source).toContain('aria-expanded={isExpanded}');
  });

  it('routes tree rows through TouchTarget without hand-patched coarse 44px classes', () => {
    expect(source).toContain("import { TouchTarget } from '@/components/ui/TouchTarget';");
    expect(source.match(/<TouchTarget asChild>/g)).toHaveLength(2);
    expect(source).not.toContain('[@media(pointer:coarse)]:min-h-[44px]');
    expect(source).not.toContain('[@media(pointer:coarse)]:!min-h-[44px]');
    expect(source).not.toContain('[@media(pointer:coarse)]:!min-h-11');
  });

  it('resolves t inside FolderNode so the label reacts to locale changes', () => {
    const folderNodeBody = source.slice(
      source.indexOf('function FolderNode('),
      source.indexOf('export function FolderPickerDialog(')
    );
    expect(folderNodeBody).toContain("const { t } = useTranslation('learningHub');");
  });
});
