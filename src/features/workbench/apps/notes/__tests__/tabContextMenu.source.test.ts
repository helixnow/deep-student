/**
 * 笔记工作区标签页右键菜单 — source 守卫（2026-10 用户反馈）
 * - 菜单项只写动作，不再把完整资料名拼进「固定 / 在右侧分屏打开 / 关闭」（长标题折行、压住图标）；
 * - 菜单出现在标签下方而不是指针处（指针在标签上，菜单会盖住标签）；
 * - 视口限制按菜单实测尺寸做，不再用固定 148px 估高。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(process.cwd(), 'src/features/workbench/apps/notes/NotesWorkspaceApp.tsx'), 'utf8');
const menuStart = source.indexOf('id="notes-tab-context-menu"');
const menu = source.slice(menuStart, source.indexOf('</div>\n      )}', menuStart));
const zh = JSON.parse(readFileSync(path.join(process.cwd(), 'src/locales/zh-CN/workbench.json'), 'utf8'));

describe('notes workspace tab context menu', () => {
  it('labels items with the action only', () => {
    expect(menuStart).toBeGreaterThan(0);
    expect(menu).not.toContain('title: tabContextTarget.title');
    expect(menu).toContain("t('notesWorkspace.tabs.menu.pin'");
    expect(menu).toContain("t('notesWorkspace.tabs.menu.close'");
    expect(zh.notesWorkspace.tabs.menu).toEqual({
      pin: '固定',
      unpin: '取消固定',
      openInRightSplit: '在右侧分屏打开',
      closeRightSplit: '从右侧分屏关闭',
      close: '关闭',
    });
  });

  it('keeps the full resource name for assistive tech on the menu itself', () => {
    expect(menu).toContain('aria-label={tabContextTarget.title}');
  });

  it('opens below the tab and clamps by measured size', () => {
    expect(source).toContain('y: tabBounds.bottom + 4');
    expect(source).not.toContain('window.innerHeight - 148');
    expect(source).toContain("import { clampMenuPosition } from './tree/TreeContextMenu';");
  });
});
