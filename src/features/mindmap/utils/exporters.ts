/**
 * 知识导图导出器
 *
 * 支持格式：
 * - OPML (Outline Processor Markup Language)
 * - Markdown (大纲格式，含子树导出)
 * - JSON (原生格式)
 * - XMind (Zen content.json 最小合法包，标题树 + 备注 + 任务 marker + 关联线)
 * - PNG 图片（使用 snapdom）
 * - SVG 矢量图（使用 snapdom）
 * - PDF（复用 snapdom PNG 管道 + 隐藏 iframe 系统打印，见 exportToImage format:'pdf'）
 */

import { snapdom } from '@zumer/snapdom';
import { getNodesBounds, getViewportForBounds, type Node } from '@xyflow/react';
import i18n from 'i18next';
import JSZip from 'jszip';
import { fileManager } from '@/utils/fileManager';
import type { MindMapDocument, MindMapNode } from '../types';
import {
  defaultMindMapStore,
  type MindMapStoreApi,
} from '../store/mindmapStore';

// ============================================================================
// OPML 导出
// ============================================================================

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * XML 属性值转义：额外转义换行/回车/制表符。
 * XML 解析器会对属性值做空白归一化（换行变空格），多行 note 若不用
 * 字符引用转义，round-trip 后换行会丢失。
 */
function escapeXmlAttr(str: string): string {
  return escapeXml(str)
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

function nodeToOpmlOutline(node: MindMapNode, indent: number): string {
  const indentStr = '  '.repeat(indent);
  const attrs = [`text="${escapeXmlAttr(node.text)}"`];

  if (node.note) {
    attrs.push(`_note="${escapeXmlAttr(node.note)}"`);
  }

  // 任务节点：_complete 与 Workflowy 的完成态属性兼容
  if (node.completed !== undefined) {
    attrs.push(`_complete="${node.completed ? 'true' : 'false'}"`);
  }

  if (node.refs && node.refs.length > 0) {
    const refsStr = node.refs.map(r => `${r.name}(${r.sourceId})`).join('; ');
    attrs.push(`_refs="${escapeXmlAttr(refsStr)}"`);
  }

  const children = node.children || [];
  if (children.length === 0) {
    return `${indentStr}<outline ${attrs.join(' ')} />\n`;
  }

  let result = `${indentStr}<outline ${attrs.join(' ')}>\n`;
  for (const child of children) {
    result += nodeToOpmlOutline(child, indent + 1);
  }
  result += `${indentStr}</outline>\n`;
  return result;
}

/**
 * 导出为 OPML 格式
 */
export function exportToOpml(doc: MindMapDocument, title?: string): string {
  const docTitle = title || doc.root.text || 'MindMap';
  const createdAt = doc.meta?.createdAt || new Date().toISOString();

  let opml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  opml += `<opml version="2.0">\n`;
  opml += `  <head>\n`;
  opml += `    <title>${escapeXml(docTitle)}</title>\n`;
  opml += `    <dateCreated>${createdAt}</dateCreated>\n`;
  opml += `  </head>\n`;
  opml += `  <body>\n`;
  opml += nodeToOpmlOutline(doc.root, 2);
  opml += `  </body>\n`;
  opml += `</opml>\n`;

  return opml;
}

// ============================================================================
// Markdown 导出
// ============================================================================

/**
 * note 续行转义：行首若出现列表/任务标记或 `>`，加 `\` 前缀。
 * 防止 round-trip 导入时被误解析为子节点，或被旧格式的引用前缀剥离逻辑破坏
 * （导入侧对称反转义）。
 */
function escapeMarkdownNoteLine(line: string): string {
  return line.replace(/^([-*+•‣◦]\s|\d+[.)]\s|>)/, '\\$1');
}

function nodeToMarkdown(node: MindMapNode, level: number): string {
  let result = '';
  // 任务节点输出 GFM checkbox（与剪贴板 Markdown 契约一致）
  const taskMark =
    node.completed === undefined ? '' : node.completed ? '[x] ' : '[ ] ';

  if (level === 0) {
    // 根节点作为标题
    result += `# ${node.text}\n`;
  } else {
    // 使用缩进列表
    const indent = '  '.repeat(level - 1);
    result += `${indent}- ${taskMark}${node.text}\n`;
  }

  // 添加注释（如果有）：输出为比所属条目深一级缩进的续行，
  // 导入侧会把缩进续行并回上一节点的 note（round-trip 对称）
  if (node.note) {
    const indent = '  '.repeat(level === 0 ? 1 : level);
    const noteLines = node.note.split('\n');
    for (const line of noteLines) {
      result += `${indent}${escapeMarkdownNoteLine(line)}\n`;
    }
  }
  if (level === 0) result += '\n';

  // 添加关联资源引用
  if (node.refs && node.refs.length > 0) {
    const indent = level === 0 ? '' : '  '.repeat(level);
    for (const ref of node.refs) {
      result += `${indent}> 📎 [${ref.name}](${ref.sourceId})\n`;
    }
    if (level === 0) result += '\n';
  }

  // 处理子节点
  const children = node.children || [];
  for (const child of children) {
    result += nodeToMarkdown(child, level + 1);
  }

  return result;
}

/**
 * 导出为 Markdown 格式（大纲结构）
 */
export function exportToMarkdown(doc: MindMapDocument): string {
  return nodeToMarkdown(doc.root, 0);
}

export interface SubtreeMarkdownOptions {
  /**
   * true 时子树根输出为 `# 标题`（与整篇文档导出一致）；
   * 默认 false：根输出为顶格列表项 `- 标题`，便于粘贴到任意大纲工具。
   */
  rootAsHeading?: boolean;
}

/**
 * 导出单个子树为 Markdown（供剪贴板 / 局部导出使用）。
 *
 * 输出契约（与 importFromMarkdown / pasteMarkdown.markdownListToNodes 往返对称）：
 * - 每个节点一行 `- 文本`，层级用 2 空格缩进表达；
 * - 任务节点输出 GFM checkbox `- [ ]` / `- [x]`；
 * - 备注输出为比条目深一级缩进的续行（行首列表标记会被 `\` 转义，导入侧反转义）；
 * - 输出以换行符结尾。
 */
export function exportSubtreeToMarkdown(
  node: MindMapNode,
  options: SubtreeMarkdownOptions = {},
): string {
  return nodeToMarkdown(node, options.rootAsHeading ? 0 : 1);
}

/**
 * 导出节点森林（多个顶层子树）为 Markdown 列表，契约同 exportSubtreeToMarkdown。
 */
export function exportNodesToMarkdown(nodes: MindMapNode[]): string {
  return nodes.map((node) => nodeToMarkdown(node, 1)).join('');
}

// ============================================================================
// JSON 导出
// ============================================================================

/**
 * 导出为 JSON 格式（原生格式）
 */
export function exportToJson(doc: MindMapDocument): string {
  return JSON.stringify(doc, null, 2);
}

/**
 * 导出为压缩的 JSON 格式
 */
export function exportToJsonCompact(doc: MindMapDocument): string {
  return JSON.stringify(doc);
}

// ============================================================================
// XMind 导出（Zen content.json 最小合法包）
// ============================================================================

interface XMindTopicJson {
  id: string;
  title: string;
  notes?: { plain: { content: string } };
  markers?: Array<{ markerId: string }>;
  style?: { properties: Record<string, string> };
  children?: { attached: XMindTopicJson[] };
}

function nodeToXMindTopic(node: MindMapNode): XMindTopicJson {
  const topic: XMindTopicJson = {
    id: node.id,
    title: node.text,
  };
  if (node.note) {
    topic.notes = { plain: { content: node.note } };
  }
  // completed → XMind 任务 marker（与导入侧 taskMarkerToCompleted 对称）
  if (node.completed !== undefined) {
    topic.markers = [{ markerId: node.completed ? 'task-done' : 'task-start' }];
  }
  // 最小样式映射：bgColor → XMind Zen 主题填充色（svg:fill），
  // 让分支配色在 XMind 中保留；其余样式（字体/字号等）仍不导出。
  if (node.style?.bgColor) {
    topic.style = { properties: { 'svg:fill': node.style.bgColor } };
  }
  const children = node.children || [];
  if (children.length > 0) {
    topic.children = { attached: children.map(nodeToXMindTopic) };
  }
  return topic;
}

/**
 * 构建 XMind Zen content.json 结构（单 sheet）。
 *
 * 导出范围（与 importFromXMind 可无损往返的最小集合）：
 * 标题树、纯文本备注、completed → task-done / task-start marker、
 * 关联线 → sheet 级 relationships、节点 bgColor → 主题填充色（svg:fill）。
 * 不导出：其余样式 / 主题、图标、挖空区间、资源引用（refs）、折叠状态。
 */
export function buildXMindContentJson(doc: MindMapDocument, title?: string): unknown[] {
  const relationships = (doc.associations || []).map((assoc) => ({
    id: assoc.id,
    end1Id: assoc.source,
    end2Id: assoc.target,
    ...(assoc.label ? { title: assoc.label } : {}),
  }));
  return [{
    id: 'sheet-1',
    class: 'sheet',
    title: title || doc.root.text || 'MindMap',
    rootTopic: nodeToXMindTopic(doc.root),
    ...(relationships.length > 0 ? { relationships } : {}),
  }];
}

/**
 * 导出为 .xmind 压缩包字节（zip 打包复用导入侧已有的 JSZip 依赖）。
 * 包含 content.json + metadata.json + manifest.json 的最小合法结构，
 * XMind Zen / XMind 2020+ 可直接打开。
 */
export async function exportToXMind(doc: MindMapDocument, title?: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('content.json', JSON.stringify(buildXMindContentJson(doc, title)));
  zip.file('metadata.json', JSON.stringify({
    creator: { name: 'Deep Student', version: '1.0' },
  }));
  zip.file('manifest.json', JSON.stringify({
    'file-entries': { 'content.json': {}, 'metadata.json': {} },
  }));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/**
 * 导出 .xmind 并弹出保存对话框。UI 只需传入文档与文件名（不含扩展名）。
 */
export async function exportToXMindFile(
  doc: MindMapDocument,
  filename: string,
  title?: string,
): Promise<{ saved: boolean }> {
  const data = await exportToXMind(doc, title);
  const saveResult = await fileManager.saveBinaryFile({
    title: i18n.t('mindmap:export.dialogExportXmind'),
    defaultFileName: `${sanitizeFilename(filename)}.xmind`,
    data,
    filters: [{ name: i18n.t('mindmap:export.filterXmind'), extensions: ['xmind'] }],
  });
  return { saved: !saveResult.canceled };
}

// ============================================================================
// 纯文本导出
// ============================================================================

function nodeToPlainText(node: MindMapNode, level: number): string {
  const indent = '  '.repeat(level);
  let result = `${indent}${node.text}\n`;

  const children = node.children || [];
  for (const child of children) {
    result += nodeToPlainText(child, level + 1);
  }

  return result;
}

/**
 * 导出为纯文本（缩进表示层级）
 */
export function exportToPlainText(doc: MindMapDocument): string {
  return nodeToPlainText(doc.root, 0);
}

// ============================================================================
// 通用导出接口
// ============================================================================

export type ExportFormat = 'opml' | 'markdown' | 'json' | 'json-compact' | 'text';

export interface ExportOptions {
  format: ExportFormat;
  title?: string;
}

/**
 * 统一导出接口
 */
export function exportMindMap(
  doc: MindMapDocument,
  options: ExportOptions
): { content: string; mimeType: string; extension: string } {
  switch (options.format) {
    case 'opml':
      return {
        content: exportToOpml(doc, options.title),
        mimeType: 'text/x-opml',
        extension: 'opml',
      };
    case 'markdown':
      return {
        content: exportToMarkdown(doc),
        mimeType: 'text/markdown',
        extension: 'md',
      };
    case 'json':
      return {
        content: exportToJson(doc),
        mimeType: 'application/json',
        extension: 'json',
      };
    case 'json-compact':
      return {
        content: exportToJsonCompact(doc),
        mimeType: 'application/json',
        extension: 'json',
      };
    case 'text':
      return {
        content: exportToPlainText(doc),
        mimeType: 'text/plain',
        extension: 'txt',
      };
    default:
      throw new Error(`Unsupported export format: ${options.format}`);
  }
}

/**
 * 触发文件下载（使用原生保存对话框，跨平台兼容）
 */
export async function downloadAsFile(
  content: string,
  filename: string,
  mimeType: string
): Promise<void> {
  const ext = filename.split('.').pop() || 'txt';
  try {
    await fileManager.saveTextFile({
      title: filename,
      defaultFileName: filename,
      content,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
  } catch (error) {
    console.error('[exporters] downloadAsFile failed:', error);
  }
}

// ============================================================================
// 图片导出 (PNG/SVG)
// ============================================================================

export type ImageFormat = 'png' | 'svg' | 'pdf';

export interface ImageExportOptions {
  format: ImageFormat;
  filename?: string;
  scale?: number;
  backgroundColor?: string;
  padding?: number;
  /** 指定导出的容器元素，避免多实例时全局选择器命中错误实例 */
  container?: HTMLElement | null;
  /** 当前 MindMapContentView 的实例 store；未传时兼容旧的默认 store。 */
  store?: MindMapStoreApi;
}

// 互斥锁：防止并发调用导致 viewport 状态竞态
let _exportLock = false;

/**
 * 零依赖 PDF 导出：把整图 PNG 装进隐藏 iframe 并触发系统打印，
 * 用户在打印对话框中选择「另存为 PDF」即可得到 PDF 文件。
 *
 * 注意：macOS WKWebView 对 window.print() 支持有限（可能静默无效）；
 * 若打印对话框未弹出，需要 Tauri 后端 webview.print() 桥接
 * （方案与接线需求见 W08 报告），本函数接口保持不变。
 */
async function printImageBlobAsPdf(blob: Blob, title: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText =
    'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;visibility:hidden;';
  document.body.appendChild(iframe);

  const cleanup = () => {
    URL.revokeObjectURL(url);
    iframe.remove();
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const idoc = iframe.contentDocument;
      const iwin = iframe.contentWindow;
      if (!idoc || !iwin) {
        reject(new Error('Print frame unavailable'));
        return;
      }
      idoc.open();
      idoc.write(
        '<!doctype html><html><head><style>'
        + '@page{margin:10mm}html,body{margin:0;padding:0}'
        + 'img{max-width:100%;height:auto;display:block}'
        + '</style></head><body></body></html>',
      );
      idoc.close();
      // 通过属性赋值设置标题（打印任务名/默认 PDF 文件名），避免 HTML 注入
      idoc.title = title;
      const img = idoc.createElement('img');
      img.onload = () => {
        try {
          iwin.focus();
          iwin.print();
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error('Print failed'));
        }
      };
      img.onerror = () => reject(new Error('Failed to load exported image for printing'));
      img.src = url;
      idoc.body.appendChild(img);
    });
  } finally {
    // 打印对话框关闭时机无法可靠感知，延迟清理保证对话框仍能读取图像
    window.setTimeout(cleanup, 60_000);
  }
}

// 额外 padding 用于防止 bezier 曲线等 edge 被裁剪
const EDGE_PADDING = 20;

// 等待所有节点完成 measured（DOM 渲染 + 尺寸测量），最长等待 maxMs
async function waitForNodesMeasured(rfInstance: { getNodes: () => unknown[] }, maxMs = 2000): Promise<void> {
  // 先让出控制权，确保 React 有机会处理 setIsExporting(true) 引起的重渲染
  // （Zustand 同步更新 store，但 React re-render 是异步调度的）
  await new Promise<void>(resolve => {
    setTimeout(resolve, 200); // 兜底：如果 rAF 因窗口不可见等原因不触发
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });

  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const nodes = rfInstance.getNodes() as Node[];
    const allMeasured = nodes.every(n => n.measured?.width && n.measured?.height);
    if (allMeasured) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // 超时仍有未 measured 的节点，继续导出但可能不完整
  console.warn('[Export] waitForNodesMeasured timed out after %dms, some nodes may lack measured dimensions', maxMs);
}

/**
 * 将 ReactFlow 画布导出为图片
 *
 * 使用 @zumer/snapdom 替代 html-to-image，性能提升 15-93 倍。
 * 截图前临时设置 viewport transform 使其精确 fit 到内容边界。
 */
export async function exportToImage(
  options: ImageExportOptions = { format: 'png' }
): Promise<{ saved: boolean }> {
  // [问题1修复] 互斥锁防止并发调用导致 viewport 状态竞态
  if (_exportLock) {
    throw new Error('Export already in progress');
  }
  _exportLock = true;
  const storeApi = options.store ?? defaultMindMapStore;
  // ★ 2026-07 加固：导出中断（尺寸超限/容器缺失等）时完整恢复交互状态。
  // 旧实现的各中断路径只重置 isExporting/progress，选中/焦点/背诵模式会永久丢失。
  let restoreInteractionState: (() => void) | null = null;

  try {
  const {
    format,
    filename = 'mindmap',
    scale = 2,
    backgroundColor = '#ffffff',
    padding = 40,
    container,
  } = options;

  // SVG 是矢量格式，不需要像素缩放
  const effectiveScale = format === 'svg' ? 1 : scale;

  // 从 store 获取 ReactFlow 实例
  const rfGetter = storeApi.getState()._reactFlowGetter;
  const rfInstance = rfGetter?.();
  const initialNodes = rfInstance?.getNodes() ?? [];
  if (initialNodes.length === 0) {
    throw new Error('No nodes to export');
  }

  // M-078: 导出前先禁用虚拟化，确保所有节点都被渲染
  // 清除选中和焦点状态，确保导出的是纯净的导图，没有高亮框和操作按钮
  const store = storeApi.getState();
  const originalSelection = store.selection;
  const originalFocusedNodeId = store.focusedNodeId;
  const originalEditingNodeId = store.editingNodeId;
  const originalEditingNoteNodeId = store.editingNoteNodeId;
  const originalReciteMode = store.reciteMode;

  // 幂等：inner finally 与 outer catch 可能各执行一次，重复恢复无副作用
  restoreInteractionState = () => {
    const current = storeApi.getState();
    current.setIsExporting(false);
    current.setExportProgress(0);
    current.setSelection(originalSelection);
    current.setFocusedNodeId(originalFocusedNodeId);
    current.setEditingNodeId(originalEditingNodeId);
    current.setEditingNoteNodeId(originalEditingNoteNodeId);
    if (originalReciteMode) {
      current.setReciteMode(true);
    }
  };

  store.setIsExporting(true);
  store.setSelection([]);
  store.setFocusedNodeId(null);
  store.setEditingNodeId(null);
  store.setEditingNoteNodeId(null);
  // 导出完整文本，不带背诵遮挡
  if (originalReciteMode) {
    store.setReciteMode(false);
  }
  store.setExportProgress(10);
  
  // 等待所有节点 DOM 渲染并完成尺寸测量（替代固定 500ms 延迟）
  if (rfInstance) {
    await waitForNodesMeasured(rfInstance);
  }
  
  storeApi.getState().setExportProgress(40);
  // 让 UI 有机会刷新
  await new Promise(resolve => setTimeout(resolve, 50));

  // 重新获取节点数据，确保拿到虚拟化禁用后最新的 measured 尺寸
  const freshNodes = (rfInstance?.getNodes() ?? []) as Node[];
  if (freshNodes.length === 0) {
    // 状态恢复与解锁统一由外层 catch 兜底
    throw new Error('No nodes to export after rendering');
  }

  // 计算所有节点的精确边界
  const nodesBounds = getNodesBounds(freshNodes);

  // 内容实际尺寸 + padding + edge 安全余量
  const totalPadding = padding + EDGE_PADDING;
  const contentWidth = nodesBounds.width + totalPadding * 2;
  const contentHeight = nodesBounds.height + totalPadding * 2;

  // 计算使内容完美适配的 viewport transform
  // 注意：contentWidth/Height 已含 totalPadding，getViewportForBounds 的 padding 参数
  // 会在其内部再从 width/height 中扣除 2*totalPadding 作为有效区域，
  // 所以有效区域 = nodesBounds 自身尺寸，zoom 结果为 1.0，totalPadding 通过 translate 偏移实现。
  const viewport = getViewportForBounds(
    nodesBounds,
    contentWidth,
    contentHeight,
    0.5,   // minZoom
    2,     // maxZoom
    totalPadding,
  );

  // [安全修复] 检查 Canvas 尺寸限制 (浏览器通常限制 ~268MP)
  // 如果尺寸过大，强制降低缩放比例
  const MAX_CANVAS_AREA = 268_000_000; // 安全余量
  let safeScale = effectiveScale;
  const estimatedArea = (contentWidth * effectiveScale) * (contentHeight * effectiveScale);
  
  if (estimatedArea > MAX_CANVAS_AREA) {
    safeScale = Math.sqrt(MAX_CANVAS_AREA / (contentWidth * contentHeight));
    // 向下取整保留2位小数，防止精度问题溢出
    safeScale = Math.floor(safeScale * 100) / 100;
    console.warn(`Export size exceeds limit, downsizing scale from ${effectiveScale} to ${safeScale}`);
    
    // 如果缩放后甚至小于 0.1，说明图太大无法导出清晰图，抛出错误让用户拆分
    if (safeScale < 0.1) {
       throw new Error('Mind map is too large to export as image. Please try splitting it.');
    }
  }

  // [问题2修复] container 已指定时，不回退到全局搜索
  const scopeRoot = container || document.querySelector('.mindmap-container');
  const reactFlowContainer = scopeRoot?.querySelector('.react-flow') as HTMLElement;
  if (!reactFlowContainer) {
    throw new Error('ReactFlow container not found');
  }

  const viewportEl = reactFlowContainer.querySelector('.react-flow__viewport') as HTMLElement;
  if (!viewportEl) {
    throw new Error('ReactFlow viewport not found');
  }

  // 保存原始状态（容器尺寸、CSS、类名 + viewport transform）
  const originalTransform = viewportEl.style.transform;
  const originalCssText = reactFlowContainer.style.cssText;
  const originalClasses = Array.from(reactFlowContainer.classList);

  // 将外层主题容器的 CSS 变量和关键类名临时下放到 reactFlowContainer
  // 因为 snapdom 是从 reactFlowContainer 开始克隆，如果不下放会导致导出图中丢失主题变量（如 --mm-border）
  if (scopeRoot instanceof HTMLElement) {
    scopeRoot.classList.forEach(cls => {
      if (cls.includes('theme') || cls === 'dark' || cls.includes('mindmap') || cls === 'mm-exporting') {
        reactFlowContainer.classList.add(cls);
      }
    });
    for (let i = 0; i < scopeRoot.style.length; i++) {
      const prop = scopeRoot.style[i];
      if (prop.startsWith('--')) {
        reactFlowContainer.style.setProperty(prop, scopeRoot.style.getPropertyValue(prop));
      }
    }
  }

  // 临时设置：
  // 1. viewport transform → 使所有节点精确 fit 到 contentWidth x contentHeight 区域
  // 2. 容器尺寸 → contentWidth x contentHeight，这样 overflow:hidden 恰好裁剪到内容边界
  viewportEl.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
  reactFlowContainer.style.width = `${contentWidth}px`;
  reactFlowContainer.style.height = `${contentHeight}px`;

  // [问题5优化] 自动降级重试逻辑
  const tryExport = async (currentScale: number, attempt = 1): Promise<{ saved: boolean }> => {
    const sanitizedFilename = sanitizeFilename(filename);
    try {
      if (attempt > 1) {
        console.warn(`[Export] Retrying with reduced scale: ${currentScale} (Attempt ${attempt})`);
        storeApi.getState().setExportProgress(50 + (attempt * 10)); // 每次重试增加一点进度反馈
      }

      // 对 reactFlowContainer 截图（不是 viewportEl）
      // 容器有 overflow:hidden，配合临时设置的尺寸和 transform，精确捕获内容区域
      const result = await snapdom(reactFlowContainer, {
        scale: currentScale,
        backgroundColor,
        embedFonts: true, // 强制内联字体，确保 PNG 渲染 KaTeX 等外部字体时不丢失
        outerTransforms: true,
        exclude: [
          '.react-flow__background',
          '.react-flow__controls',
          '.react-flow__minimap',
          '.react-flow__attribution',
        ],
      });

      if (format === 'pdf') {
        // PDF 走 PNG 光栅 → 系统打印（打印对话框中「另存为 PDF」）
        const blob = await result.toBlob({ type: 'png' });
        if (!blob) throw new Error('Failed to generate PNG blob');

        storeApi.getState().setExportProgress(90);
        await new Promise(resolve => setTimeout(resolve, 50));

        await printImageBlobAsPdf(blob, sanitizedFilename);
        return { saved: true };
      }

      if (format === 'svg') {
        const blob = await result.toBlob({ type: 'svg' });
        if (!blob) throw new Error('Failed to generate SVG blob');
        
        storeApi.getState().setExportProgress(90);
        await new Promise(resolve => setTimeout(resolve, 50));

        const svgContent = await blob.text();
        const saveResult = await fileManager.saveTextFile({
          title: i18n.t('mindmap:export.dialogSvg'),
          defaultFileName: `${sanitizedFilename}.svg`,
          content: svgContent,
          filters: [{ name: i18n.t('mindmap:export.filterSvg'), extensions: ['svg'] }],
        });
        if (saveResult.canceled) return { saved: false };
      } else {
        const blob = await result.toBlob({ type: 'png' });
        if (!blob) throw new Error('Failed to generate PNG blob');
        
        storeApi.getState().setExportProgress(90);
        await new Promise(resolve => setTimeout(resolve, 50));

        const arrayBuffer = await blob.arrayBuffer();
        const imageData = new Uint8Array(arrayBuffer);
        const saveResult = await fileManager.saveBinaryFile({
          title: i18n.t('mindmap:export.dialogPng'),
          defaultFileName: `${sanitizedFilename}.png`,
          data: imageData,
          filters: [{ name: i18n.t('mindmap:export.filterPng'), extensions: ['png'] }],
        });
        if (saveResult.canceled) return { saved: false };
      }
      return { saved: true };
    } catch (error) {
      // 如果是因为尺寸过大导致的错误，尝试降级
      const isSizeError = error instanceof Error && (
        error.message.includes('too large') || 
        error.message.includes('Failed to generate')
      );
      
      if (isSizeError && currentScale > 0.5) {
        // 降级策略：每次减半，最低 0.5
        const nextScale = Math.max(0.5, currentScale * 0.5);
        return await tryExport(nextScale, attempt + 1);
      } else {
        throw error;
      }
    }
  };

  try {
    storeApi.getState().setExportProgress(60);
    // 让 UI 有机会刷新，因为 snapdom 是重型操作
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // 开始尝试导出，初始使用计算出的安全比例
    const exportResult = await tryExport(safeScale);
    return exportResult;

  } catch (error) {
    console.error('Image export failed:', error);
    // [问题4修复] 使用 cause 保留原始错误链
    throw new Error(
      `Failed to export ${format.toUpperCase()}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { cause: error },
    );
  } finally {
    // 恢复原始状态
    viewportEl.style.transform = originalTransform;
    reactFlowContainer.style.cssText = originalCssText;
    reactFlowContainer.className = originalClasses.join(' ');

    // 恢复虚拟化、选中/焦点/编辑/背诵状态（此处必已赋值，可选调用仅为类型收窄）
    restoreInteractionState?.();
    _exportLock = false;
  }

  } catch (unexpectedError) {
    // 防御性兜底：捕获 setup 阶段（如 getNodesBounds / waitForNodesMeasured 等）的意外异常
    // 内层 finally 可能已执行清理，此处调用为幂等安全
    if (restoreInteractionState) {
      restoreInteractionState();
    } else {
      storeApi.getState().setIsExporting(false);
      storeApi.getState().setExportProgress(0);
    }
    _exportLock = false;
    throw unexpectedError;
  }
}

/**
 * 清理文件名，移除不合法字符
 */
function sanitizeFilename(filename: string): string {
  const sanitized = filename
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  return sanitized || 'mindmap';
}
