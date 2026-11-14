import { describe, expect, it, vi } from 'vitest';
import type { AppMenuContribution, AppMenuContributionFor, AppMenuWorkbench } from '../contracts/menu';
import { defineUiPlugin, UiKernel } from '../kernel';
import menuPlugin from '../../ui-plugins/official/menu';
import { resolveAppMenuRows } from '../../ui-plugins/official/menu/appMenu';

/** A menu rendered outside the workbench, as the resource library's menus will be. */
declare module '../contracts/menu' {
  interface AppMenuContexts {
    'example.board': { boardId: string; closeMenu(): void };
  }
}

const t = (key: string) => `t:${key}`;
const workbench = (): AppMenuWorkbench => ({
  launchApp: vi.fn(), openAppsPanel: vi.fn(), openCheatsheet: vi.fn(), cheatsheetShortcut: undefined, closeWindow: vi.fn(),
  closeAppWindows: vi.fn(), focusWindow: vi.fn(), setDisplayMode: vi.fn(), launchAppFrom: vi.fn(), toggleDockPinned: vi.fn(),
  closeWindowsOfApp: vi.fn(),
});

async function bootWithBoardRows(items: AppMenuContributionFor<'example.board'>['items']) {
  const kernel = new UiKernel();
  await kernel.install(menuPlugin, { origin: 'builtin' });
  await kernel.install(defineUiPlugin({ meta: { id: 'example.board-rows' }, apply(ctx) {
    ctx.ui.contribute('app.menu', { id: 'board', order: 10, value: { menu: 'example.board', items } });
    ctx.ui.contribute('app.menu', { id: 'apps', order: 20, value: { menu: 'workbench.app', items: (c) => [
      { id: 'apps', label: c.t('apps'), run: () => c.workbench.openAppsPanel() },
    ] } });
  } }));
  return { kernel, entries: kernel.slots.list<AppMenuContribution>('app.menu') };
}

describe('app.menu contexts outside the workbench', () => {
  it('gives a non-workbench menu its own context and t, without workbench, while workbench menus keep it', async () => {
    const seen: object[] = [];
    const { kernel, entries } = await bootWithBoardRows((c) => {
      seen.push(c);
      return [{ id: 'close', label: c.t(`close.${c.boardId}`), run: () => c.closeMenu() }];
    });
    const onError = vi.fn();
    const closeMenu = vi.fn();

    const board = resolveAppMenuRows(entries, 'example.board', { boardId: 'b1', closeMenu, t }, onError);
    expect(board.map(({ key, label }) => ({ key, label }))).toEqual([{ key: 'example.board-rows:board:item:close', label: 't:close.b1' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('workbench');
    if (board[0]!.kind !== 'separator') board[0]!.run!();
    expect(closeMenu).toHaveBeenCalledTimes(1);

    const actions = workbench();
    const app = resolveAppMenuRows(entries, 'workbench.app', { focusedWindowId: null, focusedTypeId: null, t, workbench: actions }, onError);
    expect(app.map((row) => row.key)).toEqual(['example.board-rows:apps:item:apps']);
    if (app[0]!.kind !== 'separator') app[0]!.run!();
    expect(actions.openAppsPanel).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    await kernel.dispose();
  });

  it('skips and reports a community row of a non-workbench menu that reads the absent workbench', async () => {
    const { kernel, entries } = await bootWithBoardRows((c) => [
      { id: 'apps', label: 'apps', run: () => (c as unknown as { workbench: AppMenuWorkbench }).workbench.openAppsPanel() },
    ]);
    const onError = vi.fn();
    const rows = resolveAppMenuRows(entries, 'example.board', { boardId: 'b1', closeMenu: vi.fn(), t }, onError);
    expect(rows.map((row) => row.key)).toEqual(['example.board-rows:board:item:apps']);
    if (rows[0]!.kind !== 'separator') rows[0]!.run!();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ owner: 'example.board-rows', id: 'board' });
    expect(onError.mock.calls[0]![1]).toBe('report');
    expect(onError.mock.calls[0]![2]).toBeInstanceOf(TypeError);
    await kernel.dispose();
  });
});
