/**
 * W17 第二批契约的编译期断言（`__tests__/w17-contracts.types.test.ts`）：
 * `editor.selectionToolbar`、`editor.blockMenu`、`EditorPurpose`/`purposes`、`resource.types`、views 懒加载工厂。
 *
 * 每个 `@ts-expect-error [标签]` 下一行必须编译失败；合法写法零诊断。
 */
import type { Context } from '@deepseek-ai/cordis';
import type {
  EditorBlockMenuContribution, EditorBlockMenuTarget, EditorExtensionContribution, EditorPurpose,
  EditorSelectionToolbarContribution,
} from '../contracts/editor';
import type { LazyShellView, ShellView, ShellViewContribution } from '../contracts/shell';
import type { ResourceTypeDefinition } from '../contracts/content';

declare const ctx: Context;
type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false;
declare function assertTrue<T extends true>(): T;

export function editorAssertions(): void {
  const purposes: EditorPurpose[] = ['editor', 'diff'];
  void purposes;

  // `purposes` 省略 = 只参与普通编辑器；diff 视图必须显式声明。
  const extension: EditorExtensionContribution = {
    create: (editor) => {
      void editor.purpose;
      return null;
    },
  };
  const diffOnly: EditorExtensionContribution = { create: () => null, purposes: ['diff'] };
  ctx.ui.contribute('editor.extensions', { id: 'ext', value: extension });
  ctx.ui.contribute('editor.extensions', { id: 'diff', value: diffOnly });

  // 浮条项：`active` 可省略（宿主补 `() => false`）。
  const toolbar: EditorSelectionToolbarContribution = {
    build: (builder) => {
      builder.addGroup('host-actions', 'More').addItem('open', { label: 'Open', icon: 'ArrowSquareOut' });
      builder.getGroup('host-actions').addItem('active', { label: 'Active', icon: 'Star', active: () => true });
    },
  };
  ctx.ui.contribute('editor.selectionToolbar', { id: 'toolbar', value: toolbar });
  const badToolbar: EditorSelectionToolbarContribution = {
    build: (builder) => {
      // @ts-expect-error [toolbar-item-icon]
      builder.addGroup('g', 'G').addItem('b', { label: 'Bold' });
    },
  };
  void badToolbar;

  const menu: EditorBlockMenuContribution = {
    rows: (target) => [
      { id: 'duplicate', label: 'Duplicate', run: (view) => void view.dispatch },
      { id: 'delete', label: 'Delete', destructive: true, disabled: target.depth === 0, run: async () => {} },
    ],
  };
  ctx.ui.contribute('editor.blockMenu', { id: 'menu', value: menu });
  assertTrue<Equal<Parameters<EditorBlockMenuContribution['rows']>[0], EditorBlockMenuTarget>>();
  assertTrue<Equal<EditorBlockMenuTarget['surface'], 'desktop-handle' | 'mobile-insert' | 'mobile-block'>>();

  const badPurpose: EditorExtensionContribution = {
    create: () => null,
    // @ts-expect-error [editor-purpose]
    purposes: ['preview'],
  };
  const badRow: EditorBlockMenuContribution = {
    // @ts-expect-error [block-menu-row]
    rows: () => [{ label: 'no id', run: () => {} }],
  };
  // @ts-expect-error [block-menu-run]
  const badRun: EditorBlockMenuContribution = { rows: () => [{ id: 'x', label: 'X', run: 'view' }] };
  void [badPurpose, badRow, badRun];
}

export function viewAssertions(): void {
  const plain: ShellView = { id: 'dashboard', titleKey: 't', component: () => null };
  const lazyView: LazyShellView = { id: 'stats', titleKey: 't', load: async () => ({ default: () => null }) };
  const all: ShellViewContribution[] = [plain, lazyView];
  ctx.ui.contribute('views', { id: 'plain', key: 'plain', value: plain });
  ctx.ui.contribute('views', { id: 'stats', key: 'stats', value: lazyView });
  void all;

  // @ts-expect-error [lazy-view-component]
  const both: LazyShellView = { id: 'x', titleKey: 't', component: () => null, load: async () => ({ default: () => null }) };
  // @ts-expect-error [lazy-view-load]
  const noLoad: LazyShellView = { id: 'y', titleKey: 't' };
  void [both, noLoad];
}

export function resourceTypeAssertions(): void {
  const note: ResourceTypeDefinition = {
    type: 'note',
    labelKey: 'resource.type.note',
    icon: 'FileText',
    order: 10,
    preview: 'markdown',
    operations: ['open', 'preview', 'rename', 'move', 'delete', 'copy', 'add-to-chat'],
  };
  const pluginKind: ResourceTypeDefinition = {
    type: 'acme.flashcard',
    labelKey: 'type.flashcard',
    preview: 'none',
    operations: ['open', 'delete'],
  };
  ctx.ui.contribute('resource.types', { id: 'note', key: 'note', value: note });
  ctx.ui.contribute('resource.types', { id: 'acme.flashcard', key: 'acme.flashcard', value: pluginKind });

  // @ts-expect-error [resource-operation]
  const badOperation: ResourceTypeDefinition = { type: 'note', labelKey: 't', operations: ['burn'] };
  // @ts-expect-error [resource-preview]
  const badPreview: ResourceTypeDefinition = { type: 'note', labelKey: 't', preview: 'webview', operations: ['open'] };
  // @ts-expect-error [resource-missing-operations]
  const noOperations: ResourceTypeDefinition = { type: 'note', labelKey: 't' };
  void [badOperation, badPreview, noOperations];
}
