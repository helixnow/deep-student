/**
 * Crepe 编辑器调试：复制到剪贴板的日志 JSON、导出文件的内容和文件名。
 */

import type { DOMSnapshot, DebugLog } from './model';

/** 复制用的日志条目：ISO 时间在前，不带 id 和 ts。 */
export const copiedLog = (log: DebugLog) => ({
  timestamp: new Date(log.ts).toISOString(),
  category: log.category,
  level: log.level,
  message: log.message,
  details: log.details,
  domSnapshot: log.domSnapshot,
  editorSnapshot: log.editorSnapshot,
});

export const exportData = (logs: DebugLog[], liveSnapshot: DOMSnapshot | null) => JSON.stringify({
  exportTime: new Date().toISOString(),
  liveSnapshot,
  logs: logs.map(l => ({
    ...l,
    timestamp: new Date(l.ts).toISOString(),
  })),
}, null, 2);

export const exportFileName = () => `crepe-editor-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
