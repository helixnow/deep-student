/**
 * v1 `ctx.ui.contextMenu.register` 的条目经真实资源菜单（LearningHubContextMenu + 官方 content 插件）渲染与执行：
 * 只在声明的资源类型上出现、点击后先关菜单再以资源调用 `run`，不触发社区错误边界。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LearningHubContextMenu, type LearningHubContextMenuProps } from '@/features/learning-hub/components/LearningHubContextMenu';
import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import contentPlugin from '../index';

vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('@/features/workbench/core/liquidGlassLens', () => ({ useLiquidGlassLens() {}, WallpaperReplica: () => null }));
vi.mock('@/app/navigation/androidBackCoordinator', () => ({ registerBackHandler: () => () => {}, BACK_PRIORITY: { overlay: 1 } }));
vi.mock('@/features/learning-hub/stores/desktopStore', () => ({
  useDesktopStore: (select: (value: unknown) => unknown) => select({
    hasResourceShortcut: () => false, hasFolderShortcut: () => false, addResourceShortcut: () => {}, addFolderShortcut: () => {},
  }),
}));

afterEach(() => cleanup());

const note = { id: 'resource-1', title: 'Resource', type: 'note', path: '/resource' };
const exam = { id: 'resource-2', title: 'Exam', type: 'exam', path: '/exam' };
const folder = { id: 'folder-1', title: 'Folder' };

it('renders and runs v1 community items in the real resource menu without tripping the error boundary', async () => {
  const kernel = new UiKernel();
  await kernel.install(contentPlugin, { origin: 'builtin' });
  const run = vi.fn();
  await kernel.install(defineUiPlugin({
    meta: { id: 'community.export' },
    apply: (ctx) => ctx.ui.contextMenu.register({ id: 'export', resourceTypes: ['note', 'folder'], labelKey: 'menu.export', order: 5, run }),
  }));
  const onOpenChange = vi.fn();
  const show = (target: LearningHubContextMenuProps['target']) => render(
    <UiKernelProvider kernel={kernel}>
      <LearningHubContextMenu open position={{ x: 0, y: 0 }} target={target} dataView="folder" onOpenChange={onOpenChange} />
    </UiKernelProvider>,
  );
  const item = () => screen.queryAllByRole('menuitem').find((row) => row.textContent?.includes('menu.export'));

  show({ type: 'resource', resource: note } as LearningHubContextMenuProps['target']);
  expect(item()).toBeTruthy();
  act(() => { fireEvent.click(item()!); });
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(run).toHaveBeenCalledWith(note);
  cleanup();

  show({ type: 'folder', folder: { folder } } as LearningHubContextMenuProps['target']);
  act(() => { fireEvent.click(item()!); });
  expect(run).toHaveBeenLastCalledWith(folder);
  cleanup();

  show({ type: 'resource', resource: exam } as LearningHubContextMenuProps['target']);
  expect(item()).toBeUndefined();
  expect(screen.queryAllByRole('menuitem').length).toBeGreaterThan(0);

  expect(kernel.errors.count('community.export')).toBe(0);
  await kernel.dispose();
});
