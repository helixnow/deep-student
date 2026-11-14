// @vitest-environment node
/**
 * `AppMenuContext` 的类型测试：编译 `app-menu-context.typetest.ts`，确认 `workbench.*` 菜单的上下文（行这一侧和宿主这一侧）
 * 仍然要求 `workbench`，工作台以外的菜单不要求、也读不到它；合法写法零诊断，每个被标注的错误恰好在标注行报错。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTypeTest } from './typecheck-helper';
import { TYPE_CONTRACT_TIMEOUT_MS } from './typecheck-budget';

describe('app.menu context types', () => {
  it('carries workbench only on workbench menus', async () => {
    const result = await runTypeTest(path.resolve(__dirname, 'app-menu-context.typetest.ts'));
    expect(result.clean).toEqual([]);
    expect(result.tags).toEqual([
      'workbench-context-needs-workbench', 'board-has-no-workbench', 'generic-host-needs-workbench',
      'finder-desktop-no-workbench', 'finder-shortcut-no-workbench', 'finder-tab-no-workbench',
      'finder-context-mismatch',
    ]);
    expect(result.unexpected).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.errors['workbench-context-needs-workbench']).toMatch(/Property 'workbench' is missing/);
    expect(result.errors['board-has-no-workbench']).toMatch(/Property 'workbench' does not exist/);
    expect(result.errors['generic-host-needs-workbench']).toMatch(/not assignable to parameter of type 'AppMenuContext<M>'/);
    for (const tag of ['finder-desktop-no-workbench', 'finder-shortcut-no-workbench', 'finder-tab-no-workbench']) {
      expect(result.errors[tag]).toMatch(/Property 'workbench' does not exist/);
    }
    expect(result.errors['finder-context-mismatch']).toMatch(/desktopRoot|addShortcut|chooseRootFolder/);
  }, TYPE_CONTRACT_TIMEOUT_MS);
});
