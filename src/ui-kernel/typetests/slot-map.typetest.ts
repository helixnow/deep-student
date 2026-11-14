/**
 * SlotMap 的编译期断言。不被应用导入；由 `npm run typecheck`（本文件不在测试排除列表内）与
 * `__tests__/slot-map.types.test.ts`（去掉 `@ts-expect-error` 后逐行确认错误真实出现）共同检查。
 *
 * 每个 `@ts-expect-error [标签]` 下一行必须因“贡献形状错误”编译失败。
 */
import type { Context } from '@deepseek-ai/cordis';
import { UiKernel } from '../kernel';
import type { SlotEntry } from '../slots';
import type { SlotName, SlotValue } from '../slot-map';
import { useOptionalSlot, useSlot, useSlotEntry } from '../react';
import type { ShellNavItem, ShellViewContribution } from '../contracts/shell';

declare module '../slot-map' {
  interface SlotMap {
    'typetest.widgets': { title: string; size: 'sm' | 'md' };
  }
}

declare const ctx: Context;
declare function expectType<T>(value: T): void;
type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false;
declare function assertTrue<T extends true>(): T;

export function contributeAssertions(): void {
  ctx.ui.contribute('typetest.widgets', { id: 'ok', order: 1, value: { title: 't', size: 'sm' } });
  // @ts-expect-error [missing-field]
  ctx.ui.contribute('typetest.widgets', { id: 'missing', value: { title: 't' } });
  // @ts-expect-error [wrong-field-type]
  ctx.ui.contribute('typetest.widgets', { id: 'wrong', value: { title: 1, size: 'sm' } });
  // @ts-expect-error [excess-field]
  ctx.ui.contribute('typetest.widgets', { id: 'excess', value: { title: 't', size: 'md', color: 'red' } });
  // @ts-expect-error [builtin-nav-shape]
  ctx.ui.contribute('nav', { id: 'n', value: { id: 'n', viewId: 'v' } });
  // @ts-expect-error [builtin-views-shape]
  ctx.ui.contribute('views', { id: 'v', key: 'v', value: { id: 'v', titleKey: 't', component: 42 } });
  // @ts-expect-error [contribution-envelope]
  ctx.ui.contribute('typetest.widgets', { value: { title: 't', size: 'sm' } });

  // Slots outside the map stay open (plugins may declare their own), and explicit generics remain an escape hatch.
  ctx.ui.contribute('typetest.undeclared', { id: 'u', value: 42 });
  ctx.ui.contribute<{ n: number }>('typetest.explicit', { id: 'e', value: { n: 1 } });
  const dynamic: string = 'typetest.dynamic';
  ctx.ui.contribute(dynamic, { id: 'd', value: 'anything' });
}

export function readAssertions(kernel: UiKernel): void {
  const widgets = kernel.slots.list('typetest.widgets');
  expectType<readonly SlotEntry<{ title: string; size: 'sm' | 'md' }>[]>(widgets);
  assertTrue<Equal<SlotValue<'nav'>, ShellNavItem>>();
  assertTrue<Equal<SlotValue<'views'>, ShellViewContribution>>();
  assertTrue<Equal<SlotValue<'typetest.undeclared'>, unknown>>();
  assertTrue<Equal<'typetest.widgets' extends SlotName ? true : false, true>>();
  // @ts-expect-error [typed-read]
  void kernel.slots.list('typetest.widgets')[0].value.color;
  // Explicit generics (used by existing official consumers) keep working.
  expectType<SlotEntry<{ legacy: true }> | undefined>(kernel.slots.get<{ legacy: true }>('views', 'x'));
}

export function HookAssertions(): null {
  const nav = useSlot('nav');
  expectType<readonly SlotEntry<ShellNavItem>[]>(nav);
  const views = useOptionalSlot('views');
  expectType<readonly SlotEntry<ShellViewContribution>[] | undefined>(views);
  const widget = useSlotEntry('typetest.widgets', 'k');
  expectType<SlotEntry<{ title: string; size: 'sm' | 'md' }> | undefined>(widget);
  const legacy = useSlot<{ title: string }>('markdown.codeBlocks');
  expectType<readonly SlotEntry<{ title: string }>[]>(legacy);
  // @ts-expect-error [typed-hook]
  void useSlot('nav')[0].value.title;
  return null;
}
