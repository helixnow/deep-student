/**
 * 经适配器登记的命令、工作台应用、对话 block / 事件 / 模式的编译期断言（`__tests__/registries.types.test.ts`）。
 *
 * 每个 `@ts-expect-error [标签]` 下一行必须因“登记值形状错误”编译失败；合法写法的返回值是撤销句柄。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ComponentType } from 'react';
import type { BlockComponentProps } from '@/features/chat/registry/blockRegistry';
import type { UiDisposer, UiWorkbenchApp } from '../kernel';

declare const ctx: Context;
declare const app: UiWorkbenchApp;
declare const Quiz: ComponentType<BlockComponentProps>;
type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false;
declare function assertTrue<T extends true>(): T;

export function registryAssertions(): void {
  const offCommand: UiDisposer = ctx.ui.commands.register({ id: 'study.open', name: 'Open', category: 'global', execute: () => undefined });
  const offApp: UiDisposer = ctx.ui.workbench.registerApp(app);
  const offBlock: UiDisposer = ctx.ui.chat.registerBlock('quiz', { type: 'quiz', component: Quiz, onAbort: 'keep-content' });
  const offEvent: UiDisposer = ctx.ui.chat.registerEvent('quiz', { onChunk: () => undefined });
  const offMode: UiDisposer = ctx.ui.chat.registerMode('quiz', { name: 'quiz', config: { requiresOcr: false, autoStartFirstMessage: false } });
  const offView: UiDisposer = ctx.ui.views.register({ id: 'quiz', titleKey: 'quiz', component: Quiz });
  for (const off of [offCommand, offApp, offBlock, offEvent, offMode, offView]) off();

  // @ts-expect-error [command-shape]
  ctx.ui.commands.register({ id: 'study.open' });
  // @ts-expect-error [command-category]
  ctx.ui.commands.register({ id: 'study.open', name: 'Open', category: 'everywhere', execute: () => undefined });
  // @ts-expect-error [app-shape]
  ctx.ui.workbench.registerApp({ typeId: 'timer' });
  // @ts-expect-error [block-component]
  ctx.ui.chat.registerBlock('quiz', { type: 'quiz', component: 'Quiz' });
  // @ts-expect-error [event-shape]
  ctx.ui.chat.registerEvent('quiz', { onChunk: 'append' });
  // @ts-expect-error [mode-shape]
  ctx.ui.chat.registerMode('quiz', { name: 'quiz' });

  assertTrue<Equal<ReturnType<typeof ctx.ui.commands.register>, UiDisposer>>();
  assertTrue<Equal<ReturnType<typeof ctx.ui.contribute>, UiDisposer>>();
}
