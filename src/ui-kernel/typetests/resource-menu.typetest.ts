/**
 * `resource.contextMenu` 行的编译期断言（`__tests__/resource-menu.types.test.ts`）。
 *
 * 每个 `@ts-expect-error [标签]` 下一行必须编译失败；合法写法零诊断。
 */
import type { Context } from '@deepseek-ai/cordis';
import type {
  ContentMenuContribution, NotesTreeMenuContext, ResourceMenuContribution, ScopedResourceMenuContribution,
} from '../contracts/content';
import type { UiDisposer } from '../kernel';

declare const ctx: Context;
type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false;
declare function assertTrue<T extends true>(): T;

export function resourceMenuAssertions(): void {
  const openSplit: ScopedResourceMenuContribution<'notes-tree'> = {
    id: 'openSplit',
    order: 20,
    scopes: ['notes-tree'],
    labelKey: 'notesWorkspace.context.openSplit',
    visible: (c) => c.item.kind !== 'folder',
    run: (c) => c.actions.openInSplit(c.item),
  };
  const off: UiDisposer = ctx.ui.contribute('resource.contextMenu', { id: 'openSplit', order: 20, value: openSplit });
  off();

  const learningHubRow: ContentMenuContribution = { id: 'refresh', order: 1, visible: (c) => c.scope === 'empty', run: (c) => c.onRefresh?.() };
  ctx.ui.contribute('resource.contextMenu', { id: 'refresh', value: learningHubRow });

  const anywhere: ScopedResourceMenuContribution = {
    id: 'copy-id', order: 1, scopes: ['resource', 'notes-tree'],
    visible: (c) => (c.scope === 'notes-tree' ? !!c.item.id : !!c.resourceItem),
  };
  const rows: ResourceMenuContribution[] = [openSplit, learningHubRow, anywhere];
  void rows;

  assertTrue<Equal<Parameters<NonNullable<typeof openSplit.run>>[0], NotesTreeMenuContext>>();

  const wrongContext: ScopedResourceMenuContribution<'notes-tree'> = {
    id: 'x', order: 1, scopes: ['notes-tree'],
    // @ts-expect-error [notes-tree-context]
    visible: (c) => !!c.resourceItem,
  };
  // @ts-expect-error [scope-name]
  const typo: ScopedResourceMenuContribution = { id: 'x', order: 1, scopes: ['notes'], visible: () => true };
  const learningHubOnly: ContentMenuContribution = {
    id: 'x', order: 1,
    // @ts-expect-error [learning-hub-context]
    visible: (c) => !!c.item,
  };
  void [wrongContext, typo, learningHubOnly];
}
