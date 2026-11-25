import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { DownloadSimple, FolderSimplePlus, Play, PushPinSimple } from '@phosphor-icons/react';
import { fileManager } from '@/utils/fileManager';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { getCollapsedMaxHeight, HTML_PREVIEW_STREAM_INTERVAL_MS } from './ChatHtmlPreview';
import { repairPartialHtml, wrapSandboxRunHtmlWithRuntimeGuard } from './chatHtmlPreviewDocument';
import { WidgetStreamFrame } from './WidgetStreamFrame';
import {
  MAX_WIDGET_STATE_BYTES,
  computeWidgetSourceHash,
  readWidgetLocalState,
  saveWidgetLocalState,
  subscribeWidgetLocalState,
  validateWidgetStatePayload,
  type WidgetStateInput,
  type WidgetStateSnapshot,
} from './widgetLocalState';
import {
  buildQuizWidgetAnswerFeedback,
  validateWidgetAnswerFeedbackEnvelope,
  type HostQuizQuestion,
  type WidgetAnswerFeedbackEnvelope,
} from '@/utils/widgetAnswerFeedback';

/**
 * 严格隔离的内联交互画板沙盒属性：
 * 仅开启 `allow-scripts`，绝不包含 `allow-same-origin`，
 * 使 iframe 运行在 opaque null origin 下，无法访问宿主 DOM / Storage / Tauri IPC。
 */
export const INTERACTIVE_HTML_CANVAS_SANDBOX = 'allow-scripts' as const;

export const MAX_LOCAL_EDIT_UNDO_STEPS = 10;

const INITIAL_CANVAS_HEIGHT = 180;
const MIN_CANVAS_HEIGHT = 56;
const EXPANDED_MAX_CANVAS_HEIGHT = 8000;

export interface InteractiveHtmlCanvasThemeSnapshot {
  '--background': string;
  '--foreground': string;
  '--muted': string;
  '--muted-foreground': string;
  '--card': string;
  '--card-foreground': string;
  '--border': string;
  '--primary': string;
  '--primary-foreground': string;
  '--destructive': string;
  '--warning': string;
  '--success': string;
  '--info': string;
  '--code-background': string;
  '--code-foreground': string;
  '--chart-1': string;
  '--chart-2': string;
  '--chart-3': string;
  '--chart-4': string;
  '--chart-5': string;
  '--chart-6': string;
  '--radius': string;
  '--font-sans': string;
  '--font-mono': string;
}

const LIGHT_FALLBACK_THEME: InteractiveHtmlCanvasThemeSnapshot = {
  '--background': 'hsl(0 0% 100%)',
  '--foreground': 'hsl(220 9% 18%)',
  '--muted': 'hsl(0 0% 94%)',
  '--muted-foreground': 'hsl(220 6% 42%)',
  '--card': 'hsl(0 0% 99%)',
  '--card-foreground': 'hsl(220 9% 18%)',
  '--border': 'hsl(0 0% 88%)',
  '--primary': 'hsl(217 70% 50%)',
  '--primary-foreground': 'hsl(0 0% 100%)',
  '--destructive': 'hsl(0 65% 51%)',
  '--warning': 'hsl(38 70% 45%)',
  '--success': 'hsl(152 60% 36%)',
  '--info': 'hsl(217 70% 50%)',
  '--code-background': 'hsl(0 0% 95%)',
  '--code-foreground': 'hsl(220 9% 18%)',
  '--chart-1': 'hsl(217 70% 50%)',
  '--chart-2': 'hsl(152 60% 36%)',
  '--chart-3': 'hsl(38 70% 45%)',
  '--chart-4': 'hsl(0 65% 51%)',
  '--chart-5': 'hsl(262 60% 52%)',
  '--chart-6': 'hsl(190 65% 42%)',
  '--radius': '8px',
  '--font-sans': 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  '--font-mono': 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
};

const DARK_FALLBACK_THEME: InteractiveHtmlCanvasThemeSnapshot = {
  '--background': 'hsl(0 0% 9%)',
  '--foreground': 'hsl(0 0% 96%)',
  '--muted': 'hsl(0 0% 14%)',
  '--muted-foreground': 'hsl(0 0% 60%)',
  '--card': 'hsl(0 0% 12%)',
  '--card-foreground': 'hsl(0 0% 96%)',
  '--border': 'hsl(0 0% 18%)',
  '--primary': 'hsl(217 65% 55%)',
  '--primary-foreground': 'hsl(0 0% 100%)',
  '--destructive': 'hsl(0 55% 45%)',
  '--warning': 'hsl(38 65% 50%)',
  '--success': 'hsl(152 55% 42%)',
  '--info': 'hsl(217 65% 55%)',
  '--code-background': 'hsl(0 0% 13%)',
  '--code-foreground': 'hsl(0 0% 96%)',
  '--chart-1': 'hsl(217 65% 55%)',
  '--chart-2': 'hsl(152 55% 42%)',
  '--chart-3': 'hsl(38 65% 50%)',
  '--chart-4': 'hsl(0 55% 45%)',
  '--chart-5': 'hsl(262 65% 60%)',
  '--chart-6': 'hsl(190 65% 50%)',
  '--radius': '8px',
  '--font-sans': 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  '--font-mono': 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
};

/**
 * 将宿主 `:root` 上的 HSL 三元组（如 `0 0% 100%`）或完整颜色值统一规范化为可直接用于
 * `color: var(--foreground)` 的合法 CSS 颜色字符串。
 */
export function normalizeThemeColorValue(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('hsl(') ||
    trimmed.startsWith('hsla(') ||
    trimmed.startsWith('rgb(') ||
    trimmed.startsWith('rgba(') ||
    trimmed.startsWith('oklch(') ||
    trimmed.startsWith('var(')
  ) {
    return trimmed;
  }
  if (/^\d+(?:\.\d+)?(?:deg)?[\s,]+\d+(?:\.\d+)?%[\s,]+\d+(?:\.\d+)?%(?:\s*\/\s*[\d.%]+)?$/i.test(trimmed)) {
    return `hsl(${trimmed})`;
  }
  return trimmed;
}

export function captureHostThemeSnapshot(): InteractiveHtmlCanvasThemeSnapshot {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return LIGHT_FALLBACK_THEME;
  }
  const root = document.documentElement;
  const isDark =
    root.classList.contains('dark') || root.getAttribute('data-theme') === 'dark';
  const base = isDark ? DARK_FALLBACK_THEME : LIGHT_FALLBACK_THEME;
  const computed = window.getComputedStyle(root);

  const readColor = (key: keyof InteractiveHtmlCanvasThemeSnapshot): string =>
    normalizeThemeColorValue(computed.getPropertyValue(key), base[key]);

  const readRaw = (key: keyof InteractiveHtmlCanvasThemeSnapshot): string => {
    const val = computed.getPropertyValue(key).trim();
    return val || base[key];
  };

  return {
    '--background': readColor('--background'),
    '--foreground': readColor('--foreground'),
    '--muted': readColor('--muted'),
    '--muted-foreground': readColor('--muted-foreground'),
    '--card': readColor('--card'),
    '--card-foreground': readColor('--card-foreground'),
    '--border': readColor('--border'),
    '--primary': readColor('--primary'),
    '--primary-foreground': readColor('--primary-foreground'),
    '--destructive': readColor('--destructive'),
    '--warning': readColor('--warning'),
    '--success': readColor('--success'),
    '--info': readColor('--info'),
    '--code-background': readColor('--code-background'),
    '--code-foreground': readColor('--code-foreground'),
    '--chart-1': readColor('--chart-1'),
    '--chart-2': readColor('--chart-2'),
    '--chart-3': readColor('--chart-3'),
    '--chart-4': readColor('--chart-4'),
    '--chart-5': readColor('--chart-5'),
    '--chart-6': readColor('--chart-6'),
    '--radius': readRaw('--radius'),
    '--font-sans': readRaw('--font-sans'),
    '--font-mono': readRaw('--font-mono'),
  };
}

/**
 * 预置高定样式类（同时兼容 `.oc-*` 与 `.ds-*` 命名体系）
 */
export const INTERACTIVE_CANVAS_PRESET_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  html {
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.55;
    color: var(--foreground);
    background: transparent;
    -webkit-text-size-adjust: 100%;
  }
  body {
    margin: 0;
    padding: 0;
    color: var(--foreground);
    background: transparent;
    overflow-x: hidden;
    overflow-wrap: break-word;
  }
  code, pre {
    font-family: var(--font-mono);
  }
  .oc-box, .ds-box {
    background: var(--card);
    color: var(--card-foreground);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.875rem 1rem;
  }
  .oc-box .oc-box, .ds-box .ds-box,
  .oc-box .ds-box, .ds-box .oc-box {
    background: var(--muted);
  }
  .oc-muted, .ds-muted {
    color: var(--muted-foreground);
  }
  .oc-table, .ds-table {
    width: 100%;
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .oc-table table, .ds-table table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  .oc-table th, .ds-table th,
  .oc-table td, .ds-table td {
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
    text-align: left;
  }
  .oc-table th, .ds-table th {
    color: var(--muted-foreground);
    font-weight: 600;
    background: var(--muted);
  }
  .oc-table tr:last-child td, .ds-table tr:last-child td {
    border-bottom: none;
  }
  .oc-num, .ds-num {
    font-variant-numeric: tabular-nums;
    text-align: end;
  }
  .oc-badge, .ds-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 500;
    background: var(--muted);
    color: var(--foreground);
    border: 1px solid var(--border);
  }
  .oc-badge[data-tone="success"], .ds-badge[data-tone="success"] {
    color: var(--success);
    border-color: var(--success);
  }
  .oc-badge[data-tone="warning"], .ds-badge[data-tone="warning"] {
    color: var(--warning);
    border-color: var(--warning);
  }
  .oc-badge[data-tone="error"], .ds-badge[data-tone="error"] {
    color: var(--destructive);
    border-color: var(--destructive);
  }
  .oc-badge[data-tone="info"], .ds-badge[data-tone="info"] {
    color: var(--info);
    border-color: var(--info);
  }
  .oc-dot, .ds-dot {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 9999px;
    background: var(--color, var(--chart-1));
  }
  .oc-bar, .ds-bar {
    display: block;
    height: 0.5rem;
    width: var(--value, 0%);
    max-width: 100%;
    border-radius: 9999px;
    background: var(--color, var(--chart-1));
    transition: width 0.2s ease;
  }
  .oc-field, .ds-field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--foreground);
  }
  .oc-input, .ds-input {
    width: 100%;
    padding: 0.45rem 0.65rem;
    font-family: inherit;
    font-size: 0.875rem;
    color: var(--foreground);
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px);
    outline: none;
  }
  .oc-input:focus, .ds-input:focus {
    border-color: var(--primary);
  }
  .oc-switch, .ds-switch {
    accent-color: var(--primary);
    width: 1rem;
    height: 1rem;
    cursor: pointer;
  }
  .oc-segmented, .ds-segmented {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    padding: 0.25rem;
    background: var(--muted);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .oc-segmented > button, .ds-segmented > button {
    appearance: none;
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    padding: 0.3rem 0.65rem;
    border-radius: calc(var(--radius) - 3px);
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
  }
  .oc-segmented > button[aria-pressed="true"],
  .ds-segmented > button[aria-pressed="true"] {
    background: var(--card);
    color: var(--foreground);
  }
  .oc-options, .ds-options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0.5rem;
  }
  .oc-option, .ds-option {
    appearance: none;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.25rem;
    width: 100%;
    padding: 0.65rem 0.85rem;
    text-align: left;
    font-family: inherit;
    font-size: 0.875rem;
    color: var(--foreground);
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    transition: border-color 0.15s ease, background-color 0.15s ease;
  }
  .oc-option[aria-pressed="true"], .ds-option[aria-pressed="true"] {
    border-color: var(--primary);
    background: var(--muted);
  }
  .oc-button, .ds-button {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    padding: 0.45rem 0.9rem;
    font-family: inherit;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--primary-foreground);
    background: var(--primary);
    border: 1px solid transparent;
    border-radius: calc(var(--radius) - 2px);
    cursor: pointer;
    transition: opacity 0.15s ease;
  }
  .oc-button[data-variant="outline"], .ds-button[data-variant="outline"] {
    background: transparent;
    color: var(--foreground);
    border-color: var(--border);
  }
  .oc-button[data-variant="destructive"], .ds-button[data-variant="destructive"] {
    background: var(--destructive);
    color: #ffffff;
  }
  .oc-button:disabled, .ds-button:disabled,
  .oc-option:disabled, .ds-option:disabled {
    opacity: 0.6;
    cursor: default;
  }
`;

export interface HtmlSearchReplacePatch {
  search: string;
  replace: string;
}

/**
 * 基于精确原始源码应用 `{ search, replace }` 局部补丁：
 * - 拒绝空 search、找不到或出现多次的歧义位置、范围重叠、无变化结果。
 */
export function applyHtmlSearchReplacePatch(
  source: string,
  patchesInput: HtmlSearchReplacePatch | HtmlSearchReplacePatch[],
): string {
  const patches = Array.isArray(patchesInput) ? patchesInput : [patchesInput];
  if (patches.length === 0 || patches.length > 30) {
    throw new Error('补丁必须包含 1 至 30 项修改');
  }

  const resolved = patches
    .map((patch) => {
      if (!patch || typeof patch !== 'object') {
        throw new Error('补丁格式不正确');
      }
      const { search, replace } = patch;
      if (typeof search !== 'string' || !search || typeof replace !== 'string') {
        throw new Error('补丁缺少有效的 search 或 replace 字段');
      }
      let start = source.indexOf(search);
      let effectiveSearch = search;
      if (start < 0 && source.includes('\r\n') !== search.includes('\r\n')) {
        const normalizedSearch = source.includes('\r\n')
          ? search.replace(/\r?\n/g, '\r\n')
          : search.replace(/\r\n/g, '\n');
        start = source.indexOf(normalizedSearch);
        if (start >= 0) {
          effectiveSearch = normalizedSearch;
        }
      }
      if (start < 0) {
        throw new Error('未在当前源码中找到匹配的 search 片段');
      }
      if (source.indexOf(effectiveSearch, start + 1) >= 0) {
        throw new Error('search 片段在源码中出现多次，请提供更精确的上下文');
      }
      return { start, end: start + effectiveSearch.length, replace };
    })
    .sort((a, b) => b.start - a.start);

  let next = source;
  let boundary = source.length;
  for (const edit of resolved) {
    if (edit.end > boundary) {
      throw new Error('多个补丁范围存在重叠，已拒绝修改');
    }
    next = next.slice(0, edit.start) + edit.replace + next.slice(edit.end);
    boundary = edit.start;
  }

  if (!next.trim()) {
    throw new Error('修改后的 HTML 源码不能为空');
  }
  if (next === source) {
    throw new Error('补丁未产生任何实质修改');
  }
  return next;
}

function serializeForScript(value: unknown): string {
  if (value === undefined) return 'null';
  try {
    return JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  } catch {
    return 'null';
  }
}

export interface InteractiveCanvasAnswerInputState {
  answer?: unknown;
  submitted?: boolean;
  question?: unknown;
}

export interface BuildInteractiveCanvasDocOptions {
  html: string;
  canvasId?: string;
  answer?: unknown;
  widgetState?: WidgetStateInput | null;
  answerInput?: InteractiveCanvasAnswerInputState | null;
  theme?: InteractiveHtmlCanvasThemeSnapshot;
}

/**
 * 构建注入了实时主题变量、`.oc-*`/`.ds-*` 预置样式以及
 * `window.dstu` / `window.openchamber` / `window.__wbw` 桥接脚本的完整 HTML `srcdoc`。
 */
export function buildInteractiveHtmlCanvasDocument({
  html,
  canvasId = 'default',
  answer = null,
  widgetState = null,
  answerInput = null,
  theme = captureHostThemeSnapshot(),
}: BuildInteractiveCanvasDocOptions): string {
  const themeVarsCss = Object.entries(theme)
    .map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]+/g, ' ')};`)
    .join(' ');
  const presetCssSingleLine = INTERACTIVE_CANVAS_PRESET_CSS.replace(/\s*[\r\n]+\s*/g, ' ').trim();

  const safeCanvasId = JSON.stringify(canvasId);
  const safeAnswer = serializeForScript(answer);
  const safeWidgetState = serializeForScript(widgetState);
  const safeAnswerInput = serializeForScript(answerInput);

  const bridgeScriptSingleLine = `(function() {
  var CANVAS_ID = ${safeCanvasId};
  var INITIAL_ANSWER = ${safeAnswer};
  var currentWidgetState = ${safeWidgetState};
  var currentAnswerInput = ${safeAnswerInput};
  var pendingRequests = new Map();
  var requestSeq = 0;
  var pendingSaveCount = 0;

  function cloneValue(val) {
    if (val === undefined || val === null) return null;
    try { return JSON.parse(JSON.stringify(val)); } catch (e) { return null; }
  }

  function sendRequest(type, payload) {
    return new Promise(function(resolve, reject) {
      var reqId = ++requestSeq;
      var timer = setTimeout(function() {
        pendingRequests.delete(reqId);
        reject(new Error('宿主未在限定时间内确认操作'));
      }, 15000);
      pendingRequests.set(reqId, { resolve: resolve, reject: reject, timer: timer });
      try {
        window.parent.postMessage(Object.assign({
          type: type,
          canvasId: CANVAS_ID,
          requestId: reqId
        }, payload), '*');
      } catch (err) {
        clearTimeout(timer);
        pendingRequests.delete(reqId);
        reject(err);
      }
    });
  }

  var bridge = {
    answer: INITIAL_ANSWER,
    get widgetState() {
      return cloneValue(currentWidgetState);
    },
    get answerInput() {
      return cloneValue(currentAnswerInput);
    },
    setWidgetState: function(nextState) {
      var normalized;
      try {
        if (!nextState || typeof nextState !== 'object' || Array.isArray(nextState)) {
          throw new Error('状态必须是 JSON 对象');
        }
        var json = JSON.stringify({
          modelContent: nextState.modelContent,
          privateContent: nextState.privateContent
        });
        if (typeof TextEncoder === 'function' && new TextEncoder().encode(json).length > ${MAX_WIDGET_STATE_BYTES}) {
          throw new Error('状态超过 16 KiB 限制');
        }
        normalized = JSON.parse(json);
      } catch (err) {
        return Promise.reject(err);
      }
      currentWidgetState = cloneValue(normalized);
      pendingSaveCount++;
      return sendRequest('ds-canvas-set-widget-state', { state: normalized }).finally(function() {
        pendingSaveCount = Math.max(0, pendingSaveCount - 1);
      });
    },
    setAnswerDraft: function(draft) {
      return sendRequest('ds-canvas-answer-draft', { draft: draft });
    },
    submitAnswer: function(answerValue) {
      return sendRequest('ds-canvas-answer-submit', { answer: answerValue });
    },
    submit: function(data, summary) {
      var resolvedSummary = typeof summary === 'string' && summary.trim()
        ? summary.trim()
        : (typeof data === 'string' ? data : '');
      try {
        window.parent.postMessage({
          type: 'ds-canvas-submit',
          canvasId: CANVAS_ID,
          data: data !== undefined ? data : null,
          summary: resolvedSummary
        }, '*');
      } catch (err) {}
      return Promise.resolve({ ok: true, data: data, summary: resolvedSummary });
    }
  };
  window.dstu = bridge;
  window.openchamber = bridge;
  window.__wbw = bridge;

  var lastReportedHeight = 0;
  function measureIntrinsicHeight() {
    var docEl = document.documentElement;
    var body = document.body;
    if (!docEl) return 0;
    if (!body) return Math.ceil(docEl.scrollHeight || docEl.offsetHeight || 0);
    var savedRootHeight = docEl.style.height;
    var savedRootMinHeight = docEl.style.minHeight;
    var savedRootDisplay = docEl.style.display;
    var savedBodyHeight = body.style.height;
    var savedBodyMinHeight = body.style.minHeight;
    var measured = 0;
    try {
      docEl.style.height = 'auto';
      docEl.style.minHeight = '0';
      docEl.style.display = 'flow-root';
      body.style.height = 'auto';
      body.style.minHeight = '0';
      var rootRectH = typeof docEl.getBoundingClientRect === 'function'
        ? docEl.getBoundingClientRect().height
        : 0;
      var bodyRectH = typeof body.getBoundingClientRect === 'function'
        ? body.getBoundingClientRect().height
        : 0;
      if (rootRectH > 0 || bodyRectH > 0) {
        measured = Math.max(rootRectH, bodyRectH, body.scrollHeight || 0, body.offsetHeight || 0);
      } else {
        measured = Math.max(
          body.scrollHeight || 0,
          body.offsetHeight || 0,
          docEl.scrollHeight || 0,
          docEl.offsetHeight || 0
        );
      }
    } finally {
      docEl.style.height = savedRootHeight;
      docEl.style.minHeight = savedRootMinHeight;
      docEl.style.display = savedRootDisplay;
      body.style.height = savedBodyHeight;
      body.style.minHeight = savedBodyMinHeight;
    }
    return Math.ceil(measured);
  }

  function resetFrameScroll() {
    try {
      if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
      if (document.documentElement) {
        document.documentElement.scrollTop = 0;
        document.documentElement.scrollLeft = 0;
      }
      if (document.body) {
        document.body.scrollTop = 0;
        document.body.scrollLeft = 0;
      }
    } catch (err) {}
  }

  function reportHeight(force) {
    try {
      var h = measureIntrinsicHeight();
      if (h > 0 && (force || Math.abs(h - lastReportedHeight) > 1)) {
        lastReportedHeight = h;
        window.parent.postMessage({
          type: 'ds-canvas-resize',
          canvasId: CANVAS_ID,
          height: h
        }, '*');
      }
    } catch (err) {}
  }

  window.addEventListener('message', function(event) {
    var data = event.data;
    if (!data || typeof data !== 'object' || data.canvasId !== CANVAS_ID) return;
    if (data.type === 'ds-canvas-ack') {
      var task = pendingRequests.get(data.requestId);
      if (!task) return;
      pendingRequests.delete(data.requestId);
      clearTimeout(task.timer);
      if (data.ok) {
        if (data.state !== undefined) {
          currentWidgetState = cloneValue(data.state);
        }
        task.resolve(data.result !== undefined ? data.result : currentWidgetState);
      } else {
        task.reject(new Error(data.error || '宿主拒绝了本次操作'));
      }
    } else if (data.type === 'ds-canvas-state-sync') {
      if (pendingSaveCount > 0) return;
      var incoming = cloneValue(data.state);
      if (JSON.stringify(currentWidgetState) === JSON.stringify(incoming)) return;
      currentWidgetState = incoming;
      window.dispatchEvent(new CustomEvent('wbw:statechange', {
        detail: { state: cloneValue(currentWidgetState) }
      }));
    } else if (data.type === 'ds-canvas-theme-sync') {
      var themeObj = data.theme;
      if (themeObj && typeof themeObj === 'object') {
        Object.keys(themeObj).forEach(function(key) {
          if (key.indexOf('--') === 0 && typeof themeObj[key] === 'string') {
            document.documentElement.style.setProperty(key, themeObj[key]);
          }
        });
      }
      window.dispatchEvent(new CustomEvent('wbw:themechange', {
        detail: { dark: Boolean(data.dark), theme: cloneValue(themeObj) }
      }));
    } else if (data.type === 'ds-canvas-answer-sync') {
      currentAnswerInput = cloneValue(data.answerInput);
      window.dispatchEvent(new CustomEvent('wbw:answerchange', {
        detail: cloneValue(currentAnswerInput)
      }));
    } else if (data.type === 'ds-canvas-remeasure') {
      resetFrameScroll();
      lastReportedHeight = 0;
      reportHeight(true);
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function() {
          resetFrameScroll();
          reportHeight(true);
        });
      }
    }
  });

  function notifyReady() {
    reportHeight(false);
    try {
      window.parent.postMessage({
        type: 'ds-canvas-ready',
        canvasId: CANVAS_ID
      }, '*');
    } catch (err) {}
  }

  if (typeof ResizeObserver === 'function') {
    var ro = new ResizeObserver(function() { reportHeight(false); });
    window.addEventListener('DOMContentLoaded', function() {
      if (document.documentElement) ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
      notifyReady();
    });
  } else {
    window.addEventListener('DOMContentLoaded', notifyReady);
  }
  window.addEventListener('resize', function() { reportHeight(false); });
  window.addEventListener('load', notifyReady);
})();`.replace(/\s*[\r\n]+\s*/g, ' ').trim();

  /* Keep injected head on a single line so runtime script error line numbers match user HTML 1:1. */
  const injectedHead = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style id="ds-canvas-theme">:root { ${themeVarsCss} } ${presetCssSingleLine}</style><script id="ds-canvas-bridge">${bridgeScriptSingleLine}</script>`;

  const leadingWhitespaceMatch = /^\s*/.exec(html);
  const leadingNewlines = leadingWhitespaceMatch
    ? leadingWhitespaceMatch[0].replace(/[^\n]/g, '')
    : '';
  const trimmed = html.trim();
  if (/^(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html|<html[\s>])/i.test(trimmed)) {
    if (/<head[\s>]/i.test(trimmed)) {
      return `${leadingNewlines}${trimmed.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${injectedHead}`)}`;
    }
    if (/<html[\s>]/i.test(trimmed)) {
      return `${leadingNewlines}${trimmed.replace(/<html(\s[^>]*)?>/i, (match) => `${match}<head>${injectedHead}</head>`)}`;
    }
    return `${leadingNewlines}${trimmed.replace(/<!doctype\s+html[^>]*>/i, (match) => `${match}<head>${injectedHead}</head>`)}`;
  }

  return `<!DOCTYPE html><html><head>${injectedHead}</head><body>${leadingNewlines}${trimmed}</body></html>`;
}

export interface InteractiveHtmlCanvasAnswerInput extends InteractiveCanvasAnswerInputState {
  onDraftChange?: (draft: unknown) => void | Promise<void>;
  onSubmitAnswer?: (answer: unknown) => void | Promise<void>;
}

export interface InteractiveHtmlCanvasProps {
  html: string;
  streaming?: boolean;
  expanded?: boolean;
  /** 注入到 `window.dstu.answer` / `window.openchamber.answer` 的已回答数据 */
  answer?: unknown;
  /** 画板内调用 `submit(data, summary)` 时触发的回调 */
  onSubmit?: (data: unknown, summary: string) => void | Promise<void>;
  onOverflowChange?: (overflowing: boolean) => void;
  title?: string;
  /** 作品模式显式标题 */
  workTitle?: string;
  /** 本机状态持久化标识（绑定键为 `(widgetId || messageId) + sourceHash`） */
  widgetId?: string;
  messageId?: string;
  /** 初始画板状态快照 */
  initialWidgetState?: WidgetStateInput | null;
  /** 状态快照保存回调 */
  onWidgetStateChange?: (snapshot: WidgetStateSnapshot) => void;
  /** 可视化提问桥配置 */
  answerInput?: InteractiveHtmlCanvasAnswerInput;
  /** 局部修改生成回调 */
  onRequestPatch?: (
    instruction: string,
    currentHtml: string,
  ) => Promise<HtmlSearchReplacePatch | HtmlSearchReplacePatch[] | string>;
  /** 局部修改或撤销后源码变化回调 */
  onHtmlChange?: (nextHtml: string, revision: number) => void;
  /** 外部受控版本号（如固定画布面板中的 v1..vN） */
  externalVersion?: number;
  /** 固定到右侧学习画布动作回调 */
  onPinToCanvas?: (payload: { html: string; title: string; widgetId: string }) => void;
  /** 存入当前学习空间动作回调 */
  onSaveToSpace?: (payload: { html: string; title: string; widgetId: string }) => void;
  /** 外部容器尺寸/视口变化信号：触发 iframe 重新测量高度并重置滚动 */
  remeasureKey?: string | number;
  className?: string;
}

type ParsedPatchDirective =
  | { kind: 'patches'; patches: HtmlSearchReplacePatch | HtmlSearchReplacePatch[] }
  | { kind: 'source'; source: string }
  | { kind: 'invalid_json'; error: Error }
  | { kind: 'none' };

function unescapeQuotedLiteral(quote: string, inner: string): string {
  if (quote === '"') {
    try {
      return JSON.parse(`"${inner}"`) as string;
    } catch {
      // fall through
    }
  }
  return inner
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function tryParseStructuredPatchInput(raw: string): ParsedPatchDirective {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json|js|javascript)?\s*\r?\n([\s\S]*?)\r?\n```$/i, '$1')
    .trim();
  if (!unfenced.startsWith('{') && !unfenced.startsWith('[')) {
    return { kind: 'none' };
  }

  try {
    const parsed = JSON.parse(unfenced) as unknown;
    if (Array.isArray(parsed)) {
      return { kind: 'patches', patches: parsed as HtmlSearchReplacePatch[] };
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as {
        search?: unknown;
        replace?: unknown;
        edits?: unknown;
        source?: unknown;
      };
      if (Array.isArray(obj.edits)) {
        return { kind: 'patches', patches: obj.edits as HtmlSearchReplacePatch[] };
      }
      if (typeof obj.source === 'string' && !('search' in obj)) {
        return { kind: 'source', source: obj.source };
      }
      return { kind: 'patches', patches: obj as HtmlSearchReplacePatch };
    }
  } catch (jsonErr) {
    // 兼容占位符提示的宽松对象字面量语法：{ search: "...", replace: "..." }
    const relaxedMatch =
      /^\{\s*['"]?search['"]?\s*:\s*(['"])((?:\\.|(?!\1)[\s\S])*)\1\s*,\s*['"]?replace['"]?\s*:\s*(['"])((?:\\.|(?!\3)[\s\S])*)\3\s*,?\s*\}$/.exec(
        unfenced,
      );
    if (relaxedMatch) {
      return {
        kind: 'patches',
        patches: {
          search: unescapeQuotedLiteral(relaxedMatch[1], relaxedMatch[2]),
          replace: unescapeQuotedLiteral(relaxedMatch[3], relaxedMatch[4]),
        },
      };
    }
    return {
      kind: 'invalid_json',
      error: jsonErr instanceof Error ? jsonErr : new Error('补丁 JSON 格式不正确'),
    };
  }

  return { kind: 'invalid_json', error: new Error('补丁 JSON 格式不正确') };
}

const DEFAULT_INTERNAL_TITLES = new Set([
  'interactive-html-canvas',
  'interactive-decision-canvas',
  'html-preview',
]);

export const InteractiveHtmlCanvas: React.FC<InteractiveHtmlCanvasProps> = ({
  html,
  streaming = false,
  expanded = false,
  answer = null,
  onSubmit,
  onOverflowChange,
  title = 'interactive-html-canvas',
  workTitle,
  widgetId,
  messageId,
  initialWidgetState,
  onWidgetStateChange,
  answerInput,
  onRequestPatch,
  onHtmlChange,
  externalVersion,
  onPinToCanvas,
  onSaveToSpace,
  remeasureKey,
  className,
}) => {
  const { t } = useTranslation('generativeUi');
  const reactId = useId();
  const canvasId = useMemo(
    () => `ds-canvas-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [reactId],
  );
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const [localHtml, setLocalHtml] = useState(html);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [revision, setRevision] = useState(1);
  const prevPropHtmlRef = useRef(html);

  useEffect(() => {
    if (html !== prevPropHtmlRef.current) {
      prevPropHtmlRef.current = html;
      setLocalHtml(html);
    }
  }, [html]);

  const [source, setSource] = useState(() =>
    streaming ? repairPartialHtml(localHtml).html : localHtml,
  );
  const latestHtmlRef = useRef(localHtml);
  latestHtmlRef.current = localHtml;
  const lastFlushRef = useRef(0);
  const lastStableRef = useRef(-1);

  useEffect(() => {
    if (!streaming) {
      lastStableRef.current = -1;
      setSource(localHtml);
      return;
    }
    const flush = () => {
      const repaired = repairPartialHtml(latestHtmlRef.current);
      if (repaired.stableLength === lastStableRef.current) return;
      lastStableRef.current = repaired.stableLength;
      lastFlushRef.current = Date.now();
      setSource(repaired.html);
    };
    const wait = HTML_PREVIEW_STREAM_INTERVAL_MS - (Date.now() - lastFlushRef.current);
    if (wait <= 0) {
      flush();
      return;
    }
    const timer = setTimeout(flush, wait);
    return () => clearTimeout(timer);
  }, [localHtml, streaming]);

  const sourceHash = useMemo(() => computeWidgetSourceHash(source), [source]);
  const ownerKey = (widgetId || messageId || canvasId).trim();

  const [widgetStateSnapshot, setWidgetStateSnapshot] = useState<WidgetStateInput | null>(() => {
    const persisted = readWidgetLocalState({
      widgetId: widgetId || canvasId,
      messageId,
      source,
      sourceHash,
    });
    if (persisted) {
      return {
        modelContent: persisted.modelContent,
        privateContent: persisted.privateContent,
      };
    }
    return initialWidgetState ?? null;
  });

  // 当源码哈希变化时，读取对应源码快照（并由 widgetLocalState 自动清空不兼容的旧快照）
  useEffect(() => {
    const persisted = readWidgetLocalState({
      widgetId: widgetId || canvasId,
      messageId,
      source,
      sourceHash,
    });
    if (persisted) {
      setWidgetStateSnapshot({
        modelContent: persisted.modelContent,
        privateContent: persisted.privateContent,
      });
    } else {
      setWidgetStateSnapshot(initialWidgetState ?? null);
    }
  }, [ownerKey, widgetId, messageId, canvasId, source, sourceHash, initialWidgetState]);

  const postToIframe = useCallback(
    (payload: Record<string, unknown>) => {
      try {
        iframeRef.current?.contentWindow?.postMessage(
          { ...payload, canvasId },
          '*',
        );
      } catch {
        // ignore cross-frame post error
      }
    },
    [canvasId],
  );

  // 订阅同浏览器跨窗口/展开页状态同步
  useEffect(() => {
    return subscribeWidgetLocalState(
      {
        widgetId: widgetId || canvasId,
        messageId,
        source,
        sourceHash,
      },
      (nextSnapshot) => {
        const nextState = nextSnapshot
          ? {
              modelContent: nextSnapshot.modelContent,
              privateContent: nextSnapshot.privateContent,
            }
          : null;
        setWidgetStateSnapshot(nextState);
        postToIframe({
          type: 'ds-canvas-state-sync',
          state: nextState,
        });
      },
    );
  }, [widgetId, messageId, canvasId, source, sourceHash, postToIframe]);

  const [themeSnapshot, setThemeSnapshot] = useState<InteractiveHtmlCanvasThemeSnapshot>(() =>
    captureHostThemeSnapshot(),
  );

  // 监听宿主主题切换（class / data-theme 变化）实时同步
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      const nextTheme = captureHostThemeSnapshot();
      setThemeSnapshot(nextTheme);
      const isDark =
        root.classList.contains('dark') || root.getAttribute('data-theme') === 'dark';
      postToIframe({
        type: 'ds-canvas-theme-sync',
        theme: nextTheme,
        dark: isDark,
      });
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    });
    return () => observer.disconnect();
  }, [postToIframe]);

  // 同步可视化提问桥状态
  useEffect(() => {
    if (!answerInput) return;
    postToIframe({
      type: 'ds-canvas-answer-sync',
      answerInput: {
        answer: answerInput.answer ?? null,
        submitted: Boolean(answerInput.submitted),
        question: answerInput.question ?? null,
      },
    });
  }, [answerInput?.answer, answerInput?.submitted, answerInput?.question, postToIframe]);

  // Keep initial snapshot in a ref for srcDoc generation so in-frame setWidgetState
  // does not remount srcDoc while still providing the latest snapshot on remount/expand.
  const initialDocStateRef = useRef<WidgetStateInput | null>(widgetStateSnapshot);
  initialDocStateRef.current = widgetStateSnapshot;

  const srcDoc = useMemo(
    () =>
      buildInteractiveHtmlCanvasDocument({
        html: wrapSandboxRunHtmlWithRuntimeGuard(source),
        canvasId,
        answer,
        widgetState: initialDocStateRef.current,
        answerInput: answerInput
          ? {
              answer: answerInput.answer ?? null,
              submitted: Boolean(answerInput.submitted),
              question: answerInput.question ?? null,
            }
          : null,
        theme: themeSnapshot,
      }),
    [source, canvasId, answer, themeSnapshot],
  );

  const [executableReady, setExecutableReady] = useState(!streaming);
  useEffect(() => {
    if (streaming) {
      setExecutableReady(false);
    }
  }, [streaming, source]);

  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [feedbackEnvelope, setFeedbackEnvelope] = useState<WidgetAnswerFeedbackEnvelope | null>(null);
  const feedbackEnvelopeRef = useRef<WidgetAnswerFeedbackEnvelope | null>(null);
  feedbackEnvelopeRef.current = feedbackEnvelope;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onWidgetStateChangeRef = useRef(onWidgetStateChange);
  onWidgetStateChangeRef.current = onWidgetStateChange;
  const answerInputRef = useRef(answerInput);
  answerInputRef.current = answerInput;

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const payload = event.data;
      if (!payload || typeof payload !== 'object') return;
      const msg = payload as {
        type?: string;
        canvasId?: string;
        requestId?: number;
        height?: unknown;
        data?: unknown;
        summary?: unknown;
        state?: unknown;
        draft?: unknown;
        answer?: unknown;
      };

      const frameWin = iframeRef.current?.contentWindow;
      const matchesSource = frameWin && event.source === frameWin;
      const matchesId = msg.canvasId === canvasId || (!msg.canvasId && event.source == null);

      if (!matchesSource && !matchesId) return;

      if (msg.type === 'ds-canvas-ready') {
        setExecutableReady(true);
      } else if (msg.type === 'ds-canvas-resize') {
        const nextHeight = Number(msg.height);
        if (Number.isFinite(nextHeight) && nextHeight > 0) {
          setContentHeight(Math.ceil(nextHeight));
          setExecutableReady(true);
        }
      } else if (msg.type === 'ds-canvas-submit') {
        const summary =
          typeof msg.summary === 'string' && msg.summary.trim()
            ? msg.summary.trim()
            : typeof msg.data === 'string'
              ? msg.data
              : '已提交';
        void onSubmitRef.current?.(msg.data ?? null, summary);
      } else if (msg.type === 'ds-canvas-set-widget-state') {
        try {
          const validated = validateWidgetStatePayload(msg.state);
          const saved = saveWidgetLocalState(
            {
              widgetId: widgetId || canvasId,
              messageId,
              source,
              sourceHash,
            },
            validated,
          );
          setWidgetStateSnapshot({
            modelContent: saved.modelContent,
            privateContent: saved.privateContent,
          });
          onWidgetStateChangeRef.current?.(saved);
          postToIframe({
            type: 'ds-canvas-ack',
            requestId: msg.requestId,
            ok: true,
            state: {
              modelContent: saved.modelContent,
              privateContent: saved.privateContent,
            },
          });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : '状态校验未通过';
          postToIframe({
            type: 'ds-canvas-ack',
            requestId: msg.requestId,
            ok: false,
            error: errorMessage,
          });
        }
      } else if (msg.type === 'ds-canvas-answer-draft') {
        const currentInput = answerInputRef.current;
        if (!currentInput || currentInput.submitted) {
          postToIframe({
            type: 'ds-canvas-ack',
            requestId: msg.requestId,
            ok: false,
            error: '当前题目不可修改作答草稿',
          });
          return;
        }
        void Promise.resolve(currentInput.onDraftChange?.(msg.draft))
          .then(() => {
            postToIframe({
              type: 'ds-canvas-ack',
              requestId: msg.requestId,
              ok: true,
              result: { draft: msg.draft },
            });
          })
          .catch((err) => {
            postToIframe({
              type: 'ds-canvas-ack',
              requestId: msg.requestId,
              ok: false,
              error: err instanceof Error ? err.message : '更新草稿失败',
            });
          });
      } else if (msg.type === 'ds-canvas-answer-submit') {
        const currentInput = answerInputRef.current;
        if (!currentInput || currentInput.submitted || !currentInput.onSubmitAnswer) {
          postToIframe({
            type: 'ds-canvas-ack',
            requestId: msg.requestId,
            ok: false,
            error: '当前题目不可直接提交答案',
          });
          return;
        }
        void Promise.resolve(currentInput.onSubmitAnswer(msg.answer))
          .then(() => {
            let evaluatedFeedback: WidgetAnswerFeedbackEnvelope | null = null;
            if (currentInput.question && typeof currentInput.question === 'object') {
              evaluatedFeedback = buildQuizWidgetAnswerFeedback({
                attemptId: (widgetId || messageId || canvasId).slice(0, 128),
                question: currentInput.question as HostQuizQuestion,
                userAnswer: msg.answer,
              });
              if (evaluatedFeedback) {
                setFeedbackEnvelope(evaluatedFeedback);
                postToIframe({
                  type: 'ds-canvas-answer-feedback',
                  feedback: evaluatedFeedback,
                });
              }
            }
            postToIframe({
              type: 'ds-canvas-ack',
              requestId: msg.requestId,
              ok: true,
              result: { submitted: true, feedback: evaluatedFeedback },
            });
          })
          .catch((err) => {
            postToIframe({
              type: 'ds-canvas-ack',
              requestId: msg.requestId,
              ok: false,
              error: err instanceof Error ? err.message : '提交答案失败',
            });
          });
      } else if (msg.type === 'ds-canvas-answer-feedback') {
        const check = validateWidgetAnswerFeedbackEnvelope(msg.data, {
          currentEnvelope: feedbackEnvelopeRef.current,
        });
        if (check.ok && check.envelope) {
          setFeedbackEnvelope(check.envelope);
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [canvasId, widgetId, messageId, source, sourceHash, postToIframe]);

  const [isExpandedView, setIsExpandedView] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceDraft, setSourceDraft] = useState(() => localHtml);
  const [editOpen, setEditOpen] = useState(false);
  const sourcePanelRef = useRef<HTMLDivElement>(null);
  const localEditBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setSourceDraft(localHtml);
  }, [localHtml]);
  useEffect(() => {
    if (sourceOpen) {
      sourcePanelRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [sourceOpen]);
  useEffect(() => {
    if (editOpen) {
      localEditBarRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [editOpen]);
  const [editInstruction, setEditInstruction] = useState('');
  const [patchSearch, setPatchSearch] = useState('');
  const [patchReplace, setPatchReplace] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');

  const effectiveExpanded = expanded || isExpandedView;
  const collapsedMax = getCollapsedMaxHeight();
  const overflowing = contentHeight !== null && contentHeight > collapsedMax;
  const onOverflowChangeRef = useRef(onOverflowChange);
  onOverflowChangeRef.current = onOverflowChange;

  useEffect(() => {
    onOverflowChangeRef.current?.(overflowing);
  }, [overflowing]);

  const requestIframeRemeasure = useCallback(() => {
    if (stageRef.current) {
      stageRef.current.scrollTop = 0;
      stageRef.current.scrollLeft = 0;
    }
    postToIframe({ type: 'ds-canvas-remeasure' });
  }, [postToIframe]);

  useEffect(() => {
    const stageEl = stageRef.current;
    if (!stageEl || typeof ResizeObserver !== 'function') return;
    let lastWidth = stageEl.clientWidth;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width ?? stageEl.clientWidth;
      if (Math.abs(nextWidth - lastWidth) > 1) {
        lastWidth = nextWidth;
        requestIframeRemeasure();
      }
    });
    observer.observe(stageEl);
    return () => observer.disconnect();
  }, [requestIframeRemeasure]);

  useEffect(() => {
    requestIframeRemeasure();
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => requestIframeRemeasure())
        : null;
    const settleTimer = window.setTimeout(() => {
      requestIframeRemeasure();
    }, 80);
    return () => {
      if (raf !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(raf);
      }
      window.clearTimeout(settleTimer);
    };
  }, [remeasureKey, isExpandedView, expanded, editOpen, sourceOpen, requestIframeRemeasure]);

  const stageHeight =
    contentHeight === null
      ? INITIAL_CANVAS_HEIGHT
      : Math.max(
          MIN_CANVAS_HEIGHT,
          Math.min(contentHeight, effectiveExpanded ? EXPANDED_MAX_CANVAS_HEIGHT : collapsedMax),
        );

  const commitNewSource = useCallback(
    (nextHtml: string) => {
      setUndoStack((prev) => [...prev.slice(-(MAX_LOCAL_EDIT_UNDO_STEPS - 1)), localHtml]);
      setLocalHtml(nextHtml);
      setRevision((prev) => {
        const nextRev = prev + 1;
        onHtmlChange?.(nextHtml, nextRev);
        return nextRev;
      });
      setEditError('');
      setPatchSearch('');
      setPatchReplace('');
      setEditInstruction('');
    },
    [localHtml, onHtmlChange],
  );

  const handleApplyEdit = async () => {
    if (editBusy) return;
    setEditError('');

    try {
      if (patchSearch.length > 0) {
        const nextHtml = applyHtmlSearchReplacePatch(localHtml, {
          search: patchSearch,
          replace: patchReplace,
        });
        commitNewSource(nextHtml);
        return;
      }

      const trimmedInstruction = editInstruction.trim();
      if (!trimmedInstruction) {
        if (patchReplace.length > 0) {
          setEditError(
            t('generativeUi:canvas.patchSearchRequired', {
              defaultValue: '请填写「查找原片段 (search)」后再应用替换',
            }),
          );
          return;
        }
        setEditError(
          onRequestPatch
            ? t('generativeUi:canvas.editRequiredWithAi', {
                defaultValue: '请输入修改要求，或填写下方查找与替换片段',
              })
            : t('generativeUi:canvas.editRequiredNoAi', {
                defaultValue: '请填写下方查找原片段与替换片段，或粘贴 { "search", "replace" } JSON 补丁',
              }),
        );
        return;
      }

      const directive = tryParseStructuredPatchInput(trimmedInstruction);
      if (directive.kind === 'patches') {
        const nextHtml = applyHtmlSearchReplacePatch(localHtml, directive.patches);
        commitNewSource(nextHtml);
        return;
      }
      if (directive.kind === 'source') {
        if (!directive.source.trim()) {
          throw new Error('修改后的 HTML 源码不能为空');
        }
        if (directive.source === localHtml) {
          throw new Error('补丁未产生任何实质修改');
        }
        commitNewSource(directive.source);
        return;
      }
      if (directive.kind === 'invalid_json') {
        throw directive.error;
      }

      if (onRequestPatch) {
        setEditBusy(true);
        const result = await onRequestPatch(trimmedInstruction, localHtml);
        const nextHtml =
          typeof result === 'string'
            ? result
            : applyHtmlSearchReplacePatch(localHtml, result);
        if (!nextHtml.trim() || nextHtml === localHtml) {
          throw new Error('未生成有效修改');
        }
        commitNewSource(nextHtml);
        return;
      }

      setEditError(
        t('generativeUi:canvas.naturalLanguageUnavailable', {
          defaultValue:
            '当前为精确片段替换模式（未接入自动 AI 改写）：请改用下方「查找原片段 / 替换为新片段」，或粘贴 { "search": "...", "replace": "..." } JSON 补丁。',
        }),
      );
    } catch (err) {
      setEditError(err instanceof Error ? err.message : '局部修改应用失败');
    } finally {
      setEditBusy(false);
    }
  };

  const handleUndoEdit = () => {
    if (undoStack.length === 0 || editBusy) return;
    const previousHtml = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));
    setLocalHtml(previousHtml);
    setRevision((prev) => {
      const nextRev = Math.max(1, prev - 1);
      onHtmlChange?.(previousHtml, nextRev);
      return nextRev;
    });
    setEditError('');
  };

  // Avoid duplicating AskUserBlockComponent's header title unless workTitle is explicitly set
  const displayTitle =
    workTitle?.trim() ||
    (!onSubmit && title && !DEFAULT_INTERNAL_TITLES.has(title) ? title.trim() : '');

  const showStreamFirstFrame = streaming || !executableReady;

  return (
    <div
      className={cn(
        'interactive-html-canvas-root flex w-full min-w-0 flex-col rounded-lg border border-border/35 bg-card/30',
        isExpandedView &&
          'fixed inset-0 z-50 h-full w-full overflow-auto rounded-none border-0 bg-background p-4',
      )}
      data-testid={isExpandedView ? 'canvas-expanded-view' : 'interactive-html-canvas-root'}
      data-expanded={isExpandedView ? 'true' : 'false'}
    >
      {/* 作品模式顶栏（位于裁切舞台之外，且随视口换行永不被右侧/顶部裁切） */}
      <div
        className="sticky top-0 z-10 flex w-full min-w-0 flex-wrap items-center justify-between gap-2 rounded-t-lg border-b border-border/35 bg-card/95 px-3 py-1.5 text-xs backdrop-blur-sm"
        data-testid="canvas-toolbar"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {isExpandedView && (
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => setIsExpandedView(false)}
              className="!h-auto inline-flex items-center gap-1 rounded !px-1.5 !py-0.5 text-xs font-medium text-foreground hover:bg-muted"
              data-testid="canvas-expanded-back"
              aria-label={t('generativeUi:canvas.back', '返回')}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
                className="shrink-0"
              >
                <path
                  d="M10 3.5L5.5 8L10 12.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>{t('generativeUi:canvas.back', '返回')}</span>
            </DsButton>
          )}
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              streaming ? 'bg-[hsl(var(--warning))]' : 'bg-[hsl(var(--success))]',
            )}
            data-testid="canvas-status-dot"
            aria-hidden="true"
          />
          {displayTitle && (
            <span
              className="truncate font-medium text-foreground"
              data-testid="canvas-work-title"
            >
              {displayTitle}
            </span>
          )}
          <span
            className="font-mono tabular-nums text-muted-foreground"
            data-testid="canvas-version-badge"
          >
            v{externalVersion ?? revision}
          </span>
          <span
            className="font-mono tabular-nums text-muted-foreground"
            data-testid="canvas-height-readout"
          >
            {stageHeight}px
          </span>
          {feedbackEnvelope && (
            <span
              data-testid="canvas-answer-feedback-badge"
              data-feedback-status={feedbackEnvelope.status}
              data-feedback-authoritative={feedbackEnvelope.authoritative ? 'true' : 'false'}
              className={cn(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium',
                feedbackEnvelope.status === 'correct'
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : feedbackEnvelope.status === 'incorrect'
                    ? 'bg-destructive/15 text-destructive'
                    : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
              )}
            >
              <span>
                {feedbackEnvelope.status === 'correct'
                  ? '回答正确'
                  : feedbackEnvelope.status === 'incorrect'
                    ? '回答错误'
                    : feedbackEnvelope.status === 'partial'
                      ? '部分正确'
                      : '待核验'}
              </span>
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {!streaming && onPinToCanvas && (
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() =>
                onPinToCanvas({
                  html: localHtml,
                  title: displayTitle || workTitle?.trim() || title,
                  widgetId: ownerKey,
                })
              }
              className="!h-auto inline-flex items-center gap-1 rounded !px-2 !py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              data-testid="canvas-pin-button"
            >
              <PushPinSimple size={13} className="shrink-0" />
              <span>{t('generativeUi:canvas.pinToCanvas', '固定到画布')}</span>
            </DsButton>
          )}
          {!streaming && onSaveToSpace && (
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() =>
                onSaveToSpace({
                  html: localHtml,
                  title: displayTitle || workTitle?.trim() || title,
                  widgetId: ownerKey,
                })
              }
              className="!h-auto inline-flex items-center gap-1 rounded !px-2 !py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              data-testid="canvas-save-space-button"
            >
              <FolderSimplePlus size={13} className="shrink-0" />
              <span>{t('generativeUi:canvas.saveToSpace', '存入空间')}</span>
            </DsButton>
          )}
          {undoStack.length > 0 && (
            <DsButton
              variant="ghost"
              size="sm"
              onClick={handleUndoEdit}
              disabled={editBusy}
              className="!h-auto inline-flex items-center gap-1 rounded !px-2 !py-0.5 text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-50"
              data-testid="canvas-undo-button"
            >
              <span>{t('generativeUi:canvas.undoEdit', '撤销修改')}</span>
              <span className="font-mono tabular-nums" data-testid="canvas-undo-count">
                ({undoStack.length})
              </span>
            </DsButton>
          )}
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => setEditOpen((prev) => !prev)}
            aria-expanded={editOpen}
            className={cn(
              '!h-auto rounded !px-2 !py-0.5 text-xs transition-colors hover:bg-muted',
              editOpen ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
            )}
            data-testid="canvas-toggle-edit"
          >
            {t('generativeUi:canvas.localEdit', '局部修改')}
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => setSourceOpen((prev) => !prev)}
            aria-expanded={sourceOpen}
            className={cn(
              '!h-auto rounded !px-2 !py-0.5 text-xs transition-colors hover:bg-muted',
              sourceOpen ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
            )}
            data-testid="canvas-toggle-source"
          >
            {t('generativeUi:canvas.source', '源码')}
          </DsButton>
          {!isExpandedView && (
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => setIsExpandedView(true)}
              className="!h-auto inline-flex items-center gap-1 rounded !px-2 !py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              data-testid="canvas-expand-button"
              aria-label={t('generativeUi:canvas.expand', '展开')}
            >
              <span>{t('generativeUi:canvas.expand', '展开')}</span>
            </DsButton>
          )}
        </div>
      </div>

      {/* 就地局部修改内联栏（置顶紧邻工具栏，输入区可滚、底部收起/应用按钮独立固定绝不被裁切） */}
      {editOpen && (
        <div
          ref={localEditBarRef}
          className="flex max-h-[min(50dvh,340px)] w-full min-w-0 shrink-0 flex-col border-b border-border/35 bg-card/95 text-xs"
          data-testid="canvas-local-edit-bar"
        >
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3 pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
              <span>
                {onRequestPatch
                  ? t('generativeUi:canvas.localEditHeader', '就地局部修改（仅作用于当前画板）')
                  : t('generativeUi:canvas.localEditExactHeader', '就地局部修改（精确片段替换 / JSON 补丁）')}
              </span>
              <span className="font-mono tabular-nums">{editInstruction.length}/2000</span>
            </div>
            {!onRequestPatch && (
              <p
                className="m-0 text-xs leading-relaxed text-muted-foreground"
                data-testid="canvas-local-edit-mode-hint"
              >
                {t('generativeUi:canvas.localEditExactHint', {
                  defaultValue:
                    '当前为精确片段替换模式：请填写下方「查找原片段」与「替换为新片段」，或粘贴 { "search": "...", "replace": "..." } JSON 补丁。',
                })}
              </p>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                type="text"
                value={patchSearch}
                disabled={editBusy}
                onChange={(e) => setPatchSearch(e.target.value)}
                placeholder={t(
                  'generativeUi:canvas.patchSearchPlaceholder',
                  '查找原片段 (search)',
                )}
                aria-label={t('generativeUi:canvas.patchSearchAria', '查找片段')}
                data-testid="canvas-patch-search"
                className="w-full rounded border border-border/35 bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:border-primary"
              />
              <input
                type="text"
                value={patchReplace}
                disabled={editBusy}
                onChange={(e) => setPatchReplace(e.target.value)}
                placeholder={t(
                  'generativeUi:canvas.patchReplacePlaceholder',
                  '替换为新片段 (replace)',
                )}
                aria-label={t('generativeUi:canvas.patchReplaceAria', '替换片段')}
                data-testid="canvas-patch-replace"
                className="w-full rounded border border-border/35 bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:border-primary"
              />
            </div>
            <input
              type="text"
              value={editInstruction}
              maxLength={2000}
              disabled={editBusy}
              onChange={(e) => setEditInstruction(e.target.value)}
              placeholder={
                onRequestPatch
                  ? t(
                      'generativeUi:canvas.editInstructionPlaceholder',
                      '输入修改要求，或粘贴 { search, replace } JSON 补丁',
                    )
                  : t(
                      'generativeUi:canvas.editJsonPatchPlaceholder',
                      '可选：粘贴 { "search": "...", "replace": "..." } JSON 补丁',
                    )
              }
              aria-label={
                onRequestPatch
                  ? t('generativeUi:canvas.editInstructionAria', '修改要求')
                  : t('generativeUi:canvas.editJsonPatchAria', 'JSON 补丁')
              }
              data-testid="canvas-edit-instruction"
              className="w-full rounded border border-border/35 bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:border-primary"
            />
            {editError && (
              <p className="m-0 text-xs text-destructive" role="alert" data-testid="canvas-edit-error">
                {editError}
              </p>
            )}
          </div>
          <div
            className="flex shrink-0 items-center justify-end gap-2 border-t border-border/25 bg-card/95 px-3 py-2"
            data-testid="canvas-local-edit-actions"
          >
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => setEditOpen(false)}
              disabled={editBusy}
              data-testid="canvas-collapse-edit"
              className="!h-auto rounded !px-2.5 !py-1 text-xs text-muted-foreground hover:bg-muted"
            >
              {t('generativeUi:canvas.collapse', '收起')}
            </DsButton>
            <DsButton
              variant="primary"
              size="sm"
              onClick={() => void handleApplyEdit()}
              disabled={editBusy}
              data-testid="canvas-apply-patch"
              className="!h-auto rounded bg-primary !px-3 !py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {editBusy
                ? t('generativeUi:canvas.applying', '正在应用…')
                : t('generativeUi:canvas.applyEdit', '应用修改')}
            </DsButton>
          </div>
        </div>
      )}

      {/* 源码视图（紧邻工具栏，支持直接编辑并重新运行 / 下载 HTML） */}
      {sourceOpen && (
        <div
          ref={sourcePanelRef}
          className="shrink-0 border-b border-border/35 bg-muted/30 p-3"
          data-testid="canvas-source-view"
        >
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{t('generativeUi:canvas.htmlSource', 'HTML 源码')}</span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono tabular-nums">
                {t('generativeUi:canvas.charCount', {
                  count: sourceDraft.length,
                  defaultValue: '{{count}} 字',
                })}
              </span>
              {!streaming && (
                <>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    onClick={() => commitNewSource(sourceDraft)}
                    disabled={sourceDraft === localHtml || !sourceDraft.trim()}
                    className="!h-auto inline-flex items-center gap-1 rounded bg-primary/15 !px-2 !py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/25 hover:text-primary disabled:opacity-40"
                    data-testid="canvas-run-source-button"
                  >
                    <Play size={12} className="shrink-0" />
                    <span>{t('generativeUi:canvas.runSource', '应用并运行')}</span>
                  </DsButton>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const fileBase = (displayTitle || workTitle?.trim() || title || 'canvas').replace(/[\\/:*?"<>|]+/g, '_');
                      const fileName = `${fileBase}.html`;
                      void fileManager.saveTextFile({
                        title: fileName,
                        defaultFileName: fileName,
                        content: localHtml,
                        filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
                      });
                    }}
                    className="!h-auto inline-flex items-center gap-1 rounded border border-border/40 bg-background/70 !px-2 !py-0.5 text-xs text-foreground transition-colors hover:bg-muted"
                    data-testid="canvas-download-html-button"
                  >
                    <DownloadSimple size={12} className="shrink-0" />
                    <span>{t('generativeUi:canvas.downloadHtml', '下载 HTML')}</span>
                  </DsButton>
                </>
              )}
            </div>
          </div>
          <code className="sr-only" aria-hidden="true">{localHtml}</code>
          <textarea
            value={sourceDraft}
            onChange={(e) => setSourceDraft(e.target.value)}
            readOnly={streaming}
            aria-label={t('generativeUi:canvas.htmlSource', 'HTML 源码')}
            placeholder={t('generativeUi:canvas.sourcePlaceholder', '编辑 HTML / CSS / JS 源码…')}
            data-testid="canvas-source-editor"
            rows={10}
            className="max-h-72 w-full resize-y rounded border border-border/40 bg-background p-2 font-mono text-xs text-foreground outline-none focus:border-primary"
          />
        </div>
      )}

      {/* 画板舞台 */}
      <div
        ref={stageRef}
        className={cn(
          'interactive-html-canvas-stage relative w-full rounded-b-lg',
          effectiveExpanded ? 'overflow-x-hidden overflow-y-auto' : 'overflow-hidden',
          className,
        )}
        data-interactive-html-canvas=""
        data-canvas-id={canvasId}
        style={{ height: stageHeight }}
      >
        {showStreamFirstFrame && (
          <WidgetStreamFrame
            html={source}
            theme={themeSnapshot}
            height={stageHeight}
            title={`${title}-stream-preview`}
            className="absolute inset-0 z-10"
            testId="widget-stream-frame"
          />
        )}
        <iframe
          ref={iframeRef}
          className="interactive-html-canvas-frame h-full w-full border-0 bg-transparent"
          sandbox={INTERACTIVE_HTML_CANVAS_SANDBOX}
          srcDoc={srcDoc}
          title={title}
          onLoad={() => {
            if (!streaming) {
              setExecutableReady(true);
            }
            requestIframeRemeasure();
          }}
        />
      </div>
    </div>
  );
};

export default InteractiveHtmlCanvas;
