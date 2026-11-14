/**
 * `chat.toolResults` 的编译期断言（`__tests__/chat-slots.types.test.ts` 逐行确认错误真实出现）。
 *
 * 每个 `@ts-expect-error [标签]` 下一行必须因“贡献形状错误”编译失败。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ComponentType } from 'react';
import { UiKernel } from '../kernel';
import type { SlotValue } from '../slot-map';
import type { ChatToolResultContribution, ChatToolResultProps } from '../contracts/chat';

declare const ctx: Context;
declare const Card: ComponentType<ChatToolResultProps>;
type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false;
declare function assertTrue<T extends true>(): T;

export function toolResultAssertions(kernel: UiKernel): void {
  ctx.ui.contribute('chat.toolResults', { id: 'ok', key: 'essay_grade', value: { placement: 'block', component: Card } });
  ctx.ui.contribute('chat.toolResults', {
    id: 'gated', key: 'paper_save', value: { placement: 'output', component: Card, match: 'qualified', when: ({ block }) => block.status === 'success' },
  });
  ctx.ui.chat.registerToolResult('media_ocr', Card);
  ctx.ui.chat.registerToolResult('media_ocr', { placement: 'actions', component: Card });
  // @ts-expect-error [tool-result-placement]
  ctx.ui.contribute('chat.toolResults', { id: 'bad', key: 'x', value: { placement: 'inline', component: Card } });
  // @ts-expect-error [tool-result-component]
  ctx.ui.contribute('chat.toolResults', { id: 'bad', key: 'x', value: { placement: 'block', component: 'Card' } });
  // @ts-expect-error [tool-result-match]
  ctx.ui.contribute('chat.toolResults', { id: 'bad', key: 'x', value: { placement: 'block', component: Card, match: 'prefix' } });

  assertTrue<Equal<SlotValue<'chat.toolResults'>, ChatToolResultContribution>>();
  // @ts-expect-error [tool-result-typed-read]
  void kernel.slots.get('chat.toolResults', 'x')?.value.render;
}
