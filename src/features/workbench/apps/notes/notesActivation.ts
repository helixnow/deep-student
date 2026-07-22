import type { ActivationContext, ActivationResult } from '../../core/types';
import {
  activateWorkspaceResource,
  getWorkspaceActiveResource,
  requestWorkspaceResource,
  type NotesWorkspaceResourceRef,
  type NotesWorkspaceResourceType,
} from './workspaceRegistry';

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function parseResource(
  ctx: ActivationContext,
): NotesWorkspaceResourceRef | null {
  const payload = payloadRecord(ctx.payload);
  const type = (payload.resourceType ?? payload.type) as NotesWorkspaceResourceType | undefined;
  const id = payload.resourceId ?? payload.id;
  if ((type === 'note' || type === 'mindmap') && typeof id === 'string' && id.trim()) {
    return { type, id: id.trim() };
  }
  return getWorkspaceActiveResource(ctx.windowId);
}

/** 同步宿主写入后的读回校验：命中即 authoritative ack，避免 ACTION_UNVERIFIED 假阴性。 */
const ackIf = (verified: boolean): ActivationResult =>
  verified ? { handled: true, acknowledged: true } : { handled: true };

/** Notes is a tabbed host; commands resolve an explicit resource or its active tab. */
export async function handleNotesActivation(
  ctx: ActivationContext,
): Promise<ActivationResult> {
  const resource = parseResource(ctx);
  if (ctx.action === 'openResource') {
    if (!resource) {
      return {
        handled: false,
        code: 'INVALID_ARGS',
        hint: 'openResource 需要 resourceType=note|mindmap 和 resourceId',
      };
    }
    const windowId = await requestWorkspaceResource(resource, ctx.windowId);
    if (!windowId) {
      return { handled: false, code: 'ACTIVATION_NOT_READY', hint: '笔记应用尚未就绪' };
    }
    const active = getWorkspaceActiveResource(windowId);
    return ackIf(
      Boolean(active && active.type === resource.type && active.id === resource.id),
    );
  }
  if (!resource) {
    return { handled: false, code: 'INVALID_STATE', hint: '笔记应用当前没有活动标签页' };
  }
  const allowedForNote = ctx.action === 'scrollToHeading';
  const allowedForMindmap = [
    'focusNode',
    'setView',
    'search',
    'nextSearchResult',
    'previousSearchResult',
    'clearSearch',
  ].includes(ctx.action);
  if ((resource.type === 'note' && !allowedForNote) || (resource.type === 'mindmap' && !allowedForMindmap)) {
    return {
      handled: false,
      code: 'UNKNOWN_ACTION',
      hint: `${resource.type} 不支持指令 ${ctx.action}`,
    };
  }
  const activation = await activateWorkspaceResource(
    resource,
    ctx.action,
    ctx.payload,
    ctx.windowId,
  );
  return activation.result;
}
