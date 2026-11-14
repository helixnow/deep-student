/**
 * `plugin:event|*`（tauri-2.11.5 `src/event/plugin.rs`）。
 * listen/unlisten 记录在 main 的 JS 监听表；emit/emit_to 扇出给 JS 监听者，并作为 FrontendEvent
 * 转给 Host（对应 Rust 侧 `app.listen` 的监听者）。
 */
import type { EventTarget } from '../../../host/kernel/protocol.ts';
import { has, raw, reqInteger, reqString, type InvokeInput } from '../args.ts';
import { invalidArgs, missingKey } from '../errors.ts';
import { EVENT_NAME_DESERIALIZE_ERROR, isEventNameValid, pageFrontendEvent, parseEventTarget } from '../events.ts';
import type { BuiltinPlugin, CommandContext } from '../runtime.ts';

function eventName(input: InvokeInput): string {
  const name = reqString(input, 'event');
  if (!isEventNameValid(name)) throw invalidArgs(input.command, 'event', EVENT_NAME_DESERIALIZE_ERROR);
  return name;
}

function eventTarget(input: InvokeInput): EventTarget {
  const value = raw(input, 'target');
  if (value === undefined) throw missingKey(input.command, 'target');
  const target = parseEventTarget(value);
  if (!target) throw invalidArgs(input.command, 'target', 'invalid EventTarget');
  return target;
}

function payloadJson(input: InvokeInput): string {
  // `payload: Option<JsonValue>`：缺省或 null 都序列化为 null。
  const value = has(input, 'payload') ? raw(input, 'payload') : null;
  return JSON.stringify(value);
}

function forwardToHost(ctx: CommandContext, event: string, payload: string, target: EventTarget): void {
  ctx.runtime.host.sendMessage(pageFrontendEvent({ window: ctx.windowLabel, webview: ctx.webviewLabel }, event, JSON.parse(payload) as unknown, target));
}

export function eventPlugin(): BuiltinPlugin {
  return {
    listen: (input, ctx) => {
      const event = eventName(input);
      const target = eventTarget(input);
      const handler = reqInteger(input, 'handler', 'u32');
      const eventId = ctx.runtime.listeners.listen(ctx.webviewLabel, event, target);
      ctx.runtime.sendToWebview(ctx.webviewLabel, { type: 'listen-js', event, eventId, target, handlerId: handler });
      return eventId;
    },
    unlisten: (input, ctx) => {
      const event = eventName(input);
      const eventId = reqInteger(input, 'eventId', 'u32');
      ctx.runtime.listeners.unlisten(event, eventId);
      return null;
    },
    emit: (input, ctx) => {
      const event = eventName(input);
      const payload = payloadJson(input);
      ctx.runtime.emitJs(event, payload, null);
      forwardToHost(ctx, event, payload, { kind: 'Any' });
      return null;
    },
    emit_to: (input, ctx) => {
      const target = eventTarget(input);
      const event = eventName(input);
      const payload = payloadJson(input);
      if (target.kind === 'Any') ctx.runtime.emitJs(event, payload, null);
      else ctx.runtime.emitTo(target, event, payload);
      forwardToHost(ctx, event, payload, target);
      return null;
    },
  };
}

