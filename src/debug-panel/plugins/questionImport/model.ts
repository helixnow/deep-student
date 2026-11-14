/**
 * 题目导入调试：日志级别、阶段与日志条目的结构，以及级别配色、图标和阶段的中文标签。
 */

import type React from 'react';
import { CheckCircle, Lightning, Pulse, Warning, XCircle } from '@phosphor-icons/react';

export type ImportLogLevel = 'info' | 'warn' | 'error' | 'debug' | 'success';

export type ImportLogPhase =
  | 'frontend:invoke-start'
  | 'frontend:invoke-end'
  | 'backend:preprocessing'
  | 'backend:rendering-pages'
  | 'backend:ocr-image'
  | 'backend:ocr-phase-done'
  | 'backend:extracting-figs'
  | 'backend:structuring'
  | 'backend:session-created'
  | 'backend:chunk-start'
  | 'backend:chunk-completed'
  | 'backend:question-parsed'
  | 'backend:completed'
  | 'backend:failed'
  | 'anomaly:stuck'
  | 'anomaly:progress-regress'
  | 'system';

export interface ImportLogEntry {
  id: string;
  ts: number;
  level: ImportLogLevel;
  phase: ImportLogPhase;
  summary: string;
  detail?: unknown;
  sessionId?: string;
  percent?: number;
  durationMs?: number;
}

export const LEVEL_COLORS: Record<ImportLogLevel, string> = {
  debug: '#6b7280',
  info: '#3b82f6',
  success: '#10b981',
  warn: '#f59e0b',
  error: '#ef4444',
};

export const LEVEL_ICONS: Record<ImportLogLevel, React.FC<any>> = {
  debug: Pulse,
  info: Lightning,
  success: CheckCircle,
  warn: Warning,
  error: XCircle,
};

export const PHASE_LABELS: Record<ImportLogPhase, string> = {
  'frontend:invoke-start': '发起导入',
  'frontend:invoke-end': '调用返回',
  'backend:preprocessing': '预处理',
  'backend:rendering-pages': '页面渲染',
  'backend:ocr-image': 'VLM/OCR',
  'backend:ocr-phase-done': 'OCR完成',
  'backend:extracting-figs': '配图提取',
  'backend:structuring': 'LLM结构化',
  'backend:session-created': '会话创建',
  'backend:chunk-start': '块开始',
  'backend:chunk-completed': '块完成',
  'backend:question-parsed': '题目解析',
  'backend:completed': '★ 完成',
  'backend:failed': '✗ 失败',
  'anomaly:stuck': '⚠ 卡住',
  'anomaly:progress-regress': '⚠ 进度回退',
  'system': '系统',
};
