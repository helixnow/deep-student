import { debugChannel } from '../bus';
import type * as Panel from '../../../debug-panel/plugins/ToolCallLifecycleDebugPlugin';

export const TOOL_CALL_LIFECYCLE_DEBUG_CHANNEL = 'tool-call-lifecycle';

const channel = debugChannel<Pick<typeof Panel, 'emitToolCallDebug' | 'resetRound' | 'trackPreparing' | 'trackStart' | 'trackEnd'>>(
  TOOL_CALL_LIFECYCLE_DEBUG_CHANNEL,
);

export const emitToolCallDebug = channel.emitter('emitToolCallDebug');
export const resetRound = channel.emitter('resetRound');
export const trackPreparing = channel.emitter('trackPreparing');
export const trackStart = channel.emitter('trackStart');
export const trackEnd = channel.emitter('trackEnd');
