/**
 * `crates/dstu-core/src/events.rs::tests::event_type_strings_stay_wire_stable`。
 * 常量由 L04 的 `chat/api.ts` 发布并已在生产事件路径使用；F4 只做 wire 契约断言。
 */
import { expect, it } from 'vitest';
import { EVENT_PHASE, EVENT_TYPE, SESSION_EVENT_TYPE } from '../../../plugins/chat/api.ts';

it('event_type_strings_stay_wire_stable', () => {
  expect(EVENT_TYPE.TOOL_CALL).toBe('tool_call');
  expect(EVENT_TYPE.TOOL_APPROVAL_REQUEST).toBe('tool_approval_request');
  expect(SESSION_EVENT_TYPE.GOAL_UPDATED).toBe('goal_updated');
  expect(EVENT_PHASE.START).toBe('start');
});
