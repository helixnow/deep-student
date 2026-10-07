/**
 * 资源库底栏多选态 — source 守卫（2026-10）
 * 窄栏（经典布局的资源列表约 195px）里：计数文案曾被截成「10 …」丢掉选中数，
 * 全选开关所在容器 min-w-0 + overflow-hidden 把图标裁成半个「[」。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  path.join(process.cwd(), 'src/features/learning-hub/components/finder/FinderBatchToolbar.tsx'),
  'utf8',
);
const zh = JSON.parse(readFileSync(path.join(process.cwd(), 'src/locales/zh-CN/learningHub.json'), 'utf8'));

describe('FinderBatchToolbar selection state in a narrow footer', () => {
  it('does not let the select-all toggle shrink and get clipped', () => {
    expect(source).not.toContain('text-accent-foreground min-w-0 ml-2 overflow-hidden');
    expect(source).toContain('flex items-center gap-1 text-accent-foreground shrink-0');
  });

  it('leads the selection count with the selected number so truncation keeps it', () => {
    expect(zh.finder.statusBar.selectedOfTotal).toBe('已选 {{selected}}/{{total}}');
  });
});
