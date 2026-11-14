/**
 * Crepe 图片上传调试：「复制日志」的文本（每条一段，附详情 / DOM / 选择器 / 快照 JSON）和「诊断报告」的内容
 * （当前时间、运行环境原样、最近快照、计数和全部日志）。
 */

import { getRawUserAgentInfo } from '@/utils/platform';
import type { DebugLog, ImageBlockDOMSnapshot } from './model';

export function formatLogsForCopy(filteredLogs: DebugLog[]): string {
  return filteredLogs.map(log => {
    const time = new Date(log.ts).toISOString();
    let content = `[${time}] [${log.stage}] [${log.level.toUpperCase()}] ${log.message}`;
    if (log.details) {
      content += `\n  Details: ${JSON.stringify(log.details, null, 2)}`;
    }
    if (log.domInfo) {
      content += `\n  DOM: ${JSON.stringify(log.domInfo, null, 2)}`;
    }
    if (log.selectorMatches) {
      content += `\n  Selectors: ${JSON.stringify(log.selectorMatches, null, 2)}`;
    }
    if (log.imageBlockSnapshot) {
      content += `\n  Snapshot: ${JSON.stringify(log.imageBlockSnapshot, null, 2)}`;
    }
    return content;
  }).join('\n\n');
}

export function buildDiagnosticReport(logs: DebugLog[], lastSnapshot: ImageBlockDOMSnapshot | null) {
  return {
    timestamp: new Date().toISOString(),
    environment: {
      isTauri: typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__),
      ...getRawUserAgentInfo(),
    },
    lastSnapshot,
    logsCount: logs.length,
    errorCount: logs.filter(l => l.level === 'error').length,
    warningCount: logs.filter(l => l.level === 'warning').length,
    logs: logs.map(log => ({
      time: new Date(log.ts).toISOString(),
      stage: log.stage,
      level: log.level,
      message: log.message,
      details: log.details,
      domInfo: log.domInfo,
      selectorMatches: log.selectorMatches,
      imageBlockSnapshot: log.imageBlockSnapshot,
    })),
  };
}
