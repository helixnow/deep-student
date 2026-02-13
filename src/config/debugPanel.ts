export const DEBUG_PANEL_PLUGIN_IDS = {
  timelineInspector: 'timeline-integrity',
} as const;

export const DEBUG_TIMELINE_LAYERS = [
  { id: 'raw', historyKey: 'debugRawHistory', timestampKey: 'debugRawHistoryTimestamp' },
  { id: 'runtime', historyKey: 'debugRuntimeHistory', timestampKey: 'debugRuntimeHistoryTimestamp' },
  { id: 'host', historyKey: 'debugChatHistory', timestampKey: 'debugChatHistoryTimestamp' },
  { id: 'visible', historyKey: 'debugVisibleHistory', timestampKey: 'debugVisibleHistoryTimestamp' },
] as const;

export const DEBUG_TIMELINE_GLOBAL_KEYS = {
  runtimeGetter: '__DSTU_GET_RUNTIME_STATE__',
  autosavePayload: '__DSTU_DEBUG_AUTOSAVE_PAYLOAD__',
  streamRequest: '__DSTU_DEBUG_CONTINUE_STREAM__',
  autosaveEvent: '__DSTU_DEBUG_AUTOSAVE_EVENT__',
} as const;

